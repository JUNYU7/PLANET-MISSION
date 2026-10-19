"""Surrogate 巡视器运动模型（策划书 20.3 运动能力）。

差速底盘 + 地形物理：
- 坡度衰减：上坡可达速度按坡度余弦衰减，超过硬件爬坡能力拒绝执行；
  超过任务 max_slope 仅记违规（报告指标）
- 滑转模型：实际前进量 = 指令 × (1 − 滑转率)；滑转率由地面类别
  （沙/裸岩/巨石）+ 坡度决定，故障区内按倍数放大（RECOVERY 任务）
- 巨石障碍：语义栅格巨石当圆形障碍，几何求交判碰撞（按时间窗去重）
- 倾覆 / 卡死 / 能耗：横坡超限倾覆终止；持续无进度判卡死；
  能耗接入 sol 能量预算

所有参数来自 settings.ENV_PARAMS，可溯源；轮-土级变形物理不在本
模块职责内（Gazebo ODE 负责，见 20.6 验证闭环）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import numpy as np

from ..settings import ENV_PARAMS
from .terrain import RegionTerrain

# 语义编码（与 core.semantic 一致）
SEM_NONE, SEM_SAND, SEM_BEDROCK, SEM_BOULDER, SEM_BASE = 0, 1, 2, 3, 4
_SEM_NAME = {0: "unknown", 1: "sand", 2: "bedrock", 3: "boulder", 4: "base"}

# TI 编码（与 core.traversability 一致）
TI_BAND, TI_PASS, TI_SLOW, TI_FORBIDDEN = 0, 1, 2, 3


@dataclass
class FaultZone:
    """故障注入区（RECOVERY 任务）：多边形 + 滑转放大 + 可选锁轮。"""
    polygon: List[List[float]]
    slip_mult: float = 3.0
    wheel_lock: Optional[str] = None  # 'left' / 'right' / None

    @staticmethod
    def inside(polygon: List[List[float]], x: float, y: float) -> bool:
        """射线法点在多边形内判定。"""
        n = len(polygon)
        inside = False
        j = n - 1
        for i in range(n):
            xi, yi = polygon[i]
            xj, yj = polygon[j]
            if (yi > y) != (yj > y):
                x_cross = (xj - xi) * (y - yi) / (yj - yi) + xi
                if x < x_cross:
                    inside = not inside
            j = i
        return inside


@dataclass
class RoverState:
    x: float = 0.0
    y: float = 0.0
    yaw: float = 0.0
    energy_wh: float = 0.0
    time_s: float = 0.0
    slip_ratio: float = 0.0
    stuck_timer: float = 0.0
    last_collision_t: float = -1e9
    slip_event_t: float = -1e9


@dataclass
class StepInfo:
    advance_m: float = 0.0
    slope_deg: float = 0.0
    slip_ratio: float = 0.0
    sem: int = 0
    bump_h: float = 0.0        # 本步碾过的碎石隆起（米，0 = 未碾过）
    events: List[str] = field(default_factory=list)


class RoverModel:
    """差速小车 surrogate：step(state, v_cmd, w_cmd) → 新状态与事件。"""

    def __init__(self, terrain: RegionTerrain,
                 params: Optional[Dict[str, Any]] = None,
                 friction_mult: float = 1.0):
        self.terrain = terrain
        self.p = dict(ENV_PARAMS)
        if params:
            self.p.update(params)
        self.friction_mult = friction_mult
        self.faults: List[FaultZone] = []

    # ------------------------------------------------------------ 工具

    def slip_base(self, sem: int) -> float:
        name = _SEM_NAME.get(sem, "unknown")
        table = self.p["slip_base"]
        return float(table.get(name, table["unknown"]))

    def in_fault_zone(self, x: float, y: float) -> Optional[FaultZone]:
        for z in self.faults:
            if FaultZone.inside(z.polygon, x, y):
                return z
        return None

    def wheel_locked(self, x: float, y: float) -> Optional[str]:
        z = self.in_fault_zone(x, y)
        return z.wheel_lock if z else None

    # ------------------------------------------------------------ 主步进

    def step(self, st: RoverState, v_cmd: float, w_cmd: float,
             max_slope_deg: float = 15.0,
             climb_slope_deg: Optional[float] = None) -> StepInfo:
        p = self.p
        dt = float(p["dt"])
        info = StepInfo()

        # 1) 当前地面属性
        slope = self.terrain.slope_at(st.x, st.y)
        sem = self.terrain.sem_at(st.x, st.y)
        info.slope_deg = slope
        info.sem = sem

        # 2) 坡度限速：超过「硬件爬坡能力」才拒绝执行；超过任务
        #    max_slope 仅记违规（硬件能爬的坡照常执行，任务约束
        #    降级为报告指标——实测反馈「性能太弱，要能爬坡」）
        reject_slope = float(climb_slope_deg if climb_slope_deg is not None
                             else max_slope_deg)
        v_eff = float(np.clip(v_cmd, -p["v_max"], p["v_max"]))
        if slope > reject_slope:
            v_eff = 0.0
        else:
            v_eff *= float(np.cos(np.radians(slope)))
        if slope > max_slope_deg and v_cmd > 0.05:
            info.events.append("slope_violation")

        # 3) 滑转率：基础值 × 坡度增益 × 摩擦随机化 × 故障区倍数
        zone = self.in_fault_zone(st.x, st.y)
        zone_mult = zone.slip_mult if zone else 1.0
        slip = self.slip_base(sem) * self.friction_mult \
            * (1.0 + p["slip_slope_gain"] * slope / 10.0) * zone_mult
        slip = float(np.clip(slip, 0.0, 0.95))
        info.slip_ratio = slip
        st.slip_ratio = slip
        if slip >= p["slip_event_ratio"] and \
                st.time_s - st.slip_event_t > p["collision_dedup_s"]:
            info.events.append("slip")
            st.slip_event_t = st.time_s

        # 4) 锁轮（单轮悬空）：差速退化——锁侧不输出，等效角速度放大
        lock = self.wheel_locked(st.x, st.y)
        w_eff = float(np.clip(w_cmd, -p["w_max"], p["w_max"]))
        if lock == "left":
            w_eff = max(w_eff, 0.0) * 1.8
        elif lock == "right":
            w_eff = min(w_eff, 0.0) * 1.8

        # 5) 实际前进与积分
        advance = v_eff * (1.0 - slip)
        st.yaw += w_eff * dt
        nx = st.x + advance * np.cos(st.yaw) * dt
        ny = st.y + advance * np.sin(st.yaw) * dt

        # 6) 岩体碰撞：只有「够高」的巨石（DEM 局部隆起 ≥
        #    boulder_block_h）才挡路。语义栅格一格 1.95 m，是车体宽度的
        #    3.5 倍，实测 92.8% 的巨石格隆起 < 0.5 m——视觉上几十厘米
        #    高的碎石不该当实心墙（实测：0.197 m 碎石把车堵了 190 s）。
        #    已在岩体上时放行（挡进入、不挡逃离），否则车困在岩体上
        #    前进后退全被挡、又因激光以岩顶为地面探测不到障碍。
        block_h = float(p["boulder_block_h"])
        on_rock = self.terrain.sem_at(st.x, st.y) == SEM_BOULDER
        hit = (not self.terrain.in_bounds(nx, ny)) or \
            ((not on_rock) and (
                self.terrain.is_boulder_blocking(nx, ny, block_h) or
                self.terrain.is_boulder_blocking(
                    nx + 0.5 * np.cos(st.yaw), ny + 0.5 * np.sin(st.yaw),
                    block_h)
            ))
        if not hit and self.terrain.sem_at(nx, ny) == SEM_BOULDER:
            # 碾过碎石：按隆起比例付出速度与滑转代价（轮子爬过石面）
            prom = max(self.terrain.prominence_at(nx, ny), 0.0)
            ratio = min(prom / max(block_h, 1e-6), 1.0)
            if ratio > 0.0:
                advance *= 1.0 - float(p["boulder_bump_slow"]) * ratio
                slip = float(np.clip(
                    slip + float(p["boulder_bump_slip"]) * ratio,
                    0.0, 0.95))
                info.slip_ratio = slip
                st.slip_ratio = slip
                info.bump_h = prom
                if slip >= p["slip_event_ratio"] and \
                        st.time_s - st.slip_event_t > p["collision_dedup_s"]:
                    info.events.append("slip")
                    st.slip_event_t = st.time_s
        info.advance_m = advance
        if hit:
            if st.time_s - st.last_collision_t > p["collision_dedup_s"]:
                info.events.append("collision")
                st.last_collision_t = st.time_s
            advance = 0.0
            info.advance_m = 0.0
        else:
            st.x, st.y = nx, ny

        # 7) 卡死判定：持续指令移动（前进或倒车）但位移不足。
        #    倒车同样纳入——脱困倒车被巨石/边界挡住时若不计时，车会
        #    原地打转到超时（实测反馈：VEL=0 只有角速度）。
        if abs(v_cmd) > 0.05 and advance < 0.02:
            st.stuck_timer += dt
            if st.stuck_timer >= p["stuck_time_s"]:
                info.events.append("stuck")
        else:
            st.stuck_timer = 0.0

        # 8) 能耗（Wh）
        power = p["idle_power_w"] + p["drive_power_w"] * abs(v_eff) \
            * (1.0 + slope / 10.0)
        st.energy_wh += power * dt / 3600.0
        st.time_s += dt
        return info
