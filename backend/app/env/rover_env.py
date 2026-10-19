"""RoverEnv：任务驱动的 surrogate 训练环境（策划书第 20 章）。

标准 gym 风格接口（不依赖 gymnasium，便于评审环境直接运行）：

    obs, info = env.reset(seed=42)
    obs, reward, terminated, truncated, info = env.step(action)

后端可替换：本类即 v1 surrogate；v2 将 step 内部替换为 ros_gz 桥接的
Gazebo 物理，观测/奖励/终止/轨迹格式完全不变，上层训练代码零改动
（20.1 总体架构）。

任务驱动：环境由 Mission JSON 的 Activity 驱动，观测 / 动作 / 奖励 /
终止 / 随机化配置全部来自 Activity 的 training 块（19.3 schema）。
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from ..settings import ENV_PARAMS, MISSIONS_DIR
from .pathfinding import path_lengths
from .radar import RadarScanner
from .rover_model import FaultZone, RoverModel, RoverState
from .terrain import RegionTerrain

__all__ = ["RoverEnv", "load_mission"]


def load_mission(region: str, mission_id: str) -> Dict[str, Any]:
    """读取任务定义（dataset_repo/missions/<region>/<mission_id>.json）。"""
    path = MISSIONS_DIR / region / ("%s.json" % mission_id)
    if not path.exists():
        raise FileNotFoundError("任务不存在：%s" % path)
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _wrap_angle(a: float) -> float:
    while a > math.pi:
        a -= 2 * math.pi
    while a < -math.pi:
        a += 2 * math.pi
    return a


class RoverEnv:
    """单个 Activity 的 surrogate 环境。

    支持 TRAVERSE / TARGETED_APPROACH / SURVEY_PATH / RECOVERY
    四类任务；观测为 dict（含 obs_vector() 扁平化向量），动作为
    [线速度, 角速度]（SURVEY 追加离散「成像」通道）。

    任务扩展：
    - SURVEY_PATH 顶点拍照：从质心出发依次驶向三个顶点，到达且
      相机光轴指向质心时成像；3/3 照片拍完成任务（覆盖率仅记录）；
    - TARGETED_APPROACH 雷达成像：到位保持后先起旋（车体旋转），
      再边转边扫满 360° 一圈，绘制以火星车为原点 10 m 半径的地形
      图（扫满一圈即完成，覆盖率仅作报告指标）。
    """

    def __init__(self, region: str, activity: Dict[str, Any],
                 params: Optional[Dict[str, Any]] = None,
                 seed: Optional[int] = None):
        self.region = region
        self.activity = activity
        self.type = str(activity.get("type", "TRAVERSE"))
        self.training = dict(activity.get("training", {}))
        self.p = dict(ENV_PARAMS)
        if params:
            self.p.update(params)

        self.terrain = RegionTerrain(region)
        self.rng = np.random.default_rng(seed)
        self.seed = seed

        # 动作/观测规格（20.1 接口层）
        self.action_dim = 3 if self.type == "SURVEY_PATH" else 2
        self.observation_spec = {
            "rel_pose": 3, "vel": 2, "imu": 3, "lidar": self.p["lidar_rays"],
            "ti_local": 3, "height_rel": 1, "last_action": self.action_dim,
        }

        # 奖励权重（来自 training 块，缺省用 V4 20.4 默认值）
        default_reward = {"progress": 1.0, "arrive": 10.0, "collision": -5.0,
                          "slope": -2.0, "time": -0.01, "coverage": 5.0,
                          "photo": 2.0, "escape": 8.0}
        rw = self.training.get("reward", {})
        self.reward_w = {k: float(rw.get(k, v))
                         for k, v in default_reward.items()}

        # 随机化配置（20.5）
        rand = self.training.get("randomization", {})
        self.friction_mult = 1.0
        self.dust_tau = 0.8
        self.local_hour = 10.0

        self.rover = RoverModel(self.terrain)
        self.state = RoverState()
        self._reset_task_state()

        # 记录
        self.trajectory: List[Dict[str, Any]] = []
        self.events: List[Dict[str, Any]] = []
        self._last_sample_t = -1e9
        self.metrics: Dict[str, Any] = {}
        self._last_action = np.zeros(self.action_dim)
        self._last_vel = np.zeros(2)
        self._last_advance = 0.0
        self._terminated_reason = ""

    # ------------------------------------------------------------ 任务状态

    def _reset_task_state(self) -> None:
        """按任务类型初始化目标、预算与内部状态。"""
        self.targets = [
            (float(t["x"]), float(t["y"]))
            for t in self.activity.get("targets", [])
        ]
        budget = self.activity.get("budget", {})
        self.time_budget = float(budget.get("time_s", 1800))
        self.max_slope = float(budget.get("max_slope_deg", 15))
        # 硬件爬坡能力：拒绝指令的硬阈值（≥任务约束），任务
        # max_slope 仅作违规报告。实测反馈「性能太弱，要能爬坡」。
        self.climb_slope = max(float(self.p["rover_climb_slope_deg"]),
                               self.max_slope)
        self.tol_pos = float(self.activity.get("targets", [{}])[0]
                             .get("tol_pos_m", 3.0))
        self.tol_yaw = math.radians(float(
            self.training.get("tol_yaw_deg", self.p["tol_yaw_deg"])))
        self.hold_time = float(self.p["hold_time_s"])
        self.fov = float(self.activity.get("fov", 60))
        self.photo_tol = float(self.p["photo_tol_m"])
        # 逃离点默认值：仅 RECOVERY 会从任务数据覆盖。
        # 单目标 TRAVERSE/SURVEY_PATH 的初始朝向计算会引用此属性，
        # 缺省时抛 AttributeError 使实时仿真流在首帧前中断。
        self.escape = (0.0, 0.0)

        if self.type == "TRAVERSE":
            self.wp_index = 0
            self.hold_timer = 0.0
        elif self.type == "TARGETED_APPROACH":
            self.hold_timer = 0.0
            self._target = self.targets[0] if self.targets else (0.0, 0.0)
            orient = next((t for t in self.activity.get("targets", [])
                           if t.get("role") == "orientation"), None)
            if orient is not None:
                self._orient = (float(orient["x"]), float(orient["y"]))
            elif len(self.targets) > 1:
                self._orient = self.targets[1]
            else:
                # 单目标点（编辑器只放一个点）：车头朝向区域中心
                self._orient = (0.0, 0.0)
            # 雷达成像阶段（到位保持后追加，到达判据本身不变）：
            # approach → spinup（车体起旋）→ scan（边转边扫）→ done。
            # scan 由 RadarScanner 推进；扫满 360° 一圈即完成。
            self.phase = "approach"
            self.scanner: Optional[RadarScanner] = None
            self.scan_result: Optional[Dict[str, Any]] = None
            self._last_scan: Optional[Dict[str, Any]] = None
        elif self.type == "SURVEY_PATH":
            verts = [t for t in self.activity.get("targets", [])
                     if t.get("role", "vertex") == "vertex"]
            self.path_pts = [(float(v["x"]), float(v["y"])) for v in verts[:3]]
            if len(self.path_pts) == 3:
                self.path_pts.append(self.path_pts[0])  # 闭合回路（覆盖采样）
            # 导航用开环顶点：走完一圈回到起点后取模循环，持续巡查补
            # 覆盖，避免「目标点即自身所在顶点」导致车速归零卡死
            self.nav_pts = self.path_pts[:3]
            # 质心：role=centroid 目标（任务编辑器自动生成）；缺省取三顶点均值
            cen = next((t for t in self.activity.get("targets", [])
                        if t.get("role") == "centroid"), None)
            if cen is not None:
                self.centroid = (float(cen["x"]), float(cen["y"]))
            elif len(verts) >= 3:
                self.centroid = (
                    sum(float(v["x"]) for v in verts[:3]) / 3.0,
                    sum(float(v["y"]) for v in verts[:3]) / 3.0)
            else:
                self.centroid = self.path_pts[0] if self.path_pts else (0.0, 0.0)
            # 顶点拍照：到达顶点容差内且相机光轴指向质心时，photo 动作
            # 通道触发即记为一次成功成像（3 顶点共 3 张）
            self.photo_verts = [(float(v["x"]), float(v["y"]))
                                for v in verts[:3]]
            self.photo_done = [False] * len(self.photo_verts)
            self.photos: List[Dict[str, Any]] = []
            # 拍照时机：光轴对准质心 ±photo_yaw_tol 且停车保持
            # photo_hold_s 后才成像，避免「还没转过去照片就出现」
            self.photo_yaw_tol = math.radians(
                float(self.p["photo_yaw_tol_deg"]))
            self.photo_hold_s = float(self.p["photo_hold_s"])
            self.photo_hold_timer = 0.0
            self.survey_radius = float(self.p["survey_radius_m"])
            self.coverage_target = float(
                self.training.get("coverage_target", 0.98))
            self._build_coverage()
            self.path_index = 0
        elif self.type == "RECOVERY":
            faults = self.activity.get("faults", {})
            self.fault_zones = [
                FaultZone(polygon=[list(p) for p in z.get("polygon", [])],
                          slip_mult=float(z.get("slip_mult", 3.0)),
                          wheel_lock=z.get("wheel_lock"))
                for z in faults.get("zones", [])
            ]
            self.rover.faults = self.fault_zones
            esc = faults.get("escape", {})
            self.escape = (float(esc.get("x", 0.0)), float(esc.get("y", 0.0)))
            self._ever_out = False

    def _build_coverage(self) -> None:
        """沿勘测路径每 2 m 布覆盖采样点。"""
        self.cover_pts: List[Tuple[float, float]] = []
        if len(self.path_pts) < 2:
            return
        for a, b in zip(self.path_pts, self.path_pts[1:]):
            d = math.hypot(b[0] - a[0], b[1] - a[1])
            steps = max(int(d / 2.0), 1)
            for s in range(steps):
                t = s / steps
                self.cover_pts.append(
                    (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
        self.covered = np.zeros(len(self.cover_pts), dtype=bool)

    # ------------------------------------------------------------ 重置

    def _nearest_drivable(self, x: float, y: float) -> Tuple[float, float]:
        """就近搜索坡度不超限且在图内的点（出生点防陡坡卡死）。

        质心/航点可能落在 >max_slope 的陡坡上，此时环境拒绝一切
        前进指令，火星车会原地空转直到超时。按 1→12 m 螺旋搜索
        第一个可行驶点；都不可行驶时原地返回（交给卡死/超时兜底）。
        """
        terr = self.terrain
        if terr.in_bounds(x, y) and terr.slope_at(x, y) <= self.max_slope:
            return x, y
        for r in (1.0, 2.0, 3.0, 5.0, 8.0, 12.0):
            for k in range(16):
                a = 2.0 * math.pi * k / 16
                nx = x + r * math.cos(a)
                ny = y + r * math.sin(a)
                if terr.in_bounds(nx, ny) \
                        and terr.slope_at(nx, ny) <= self.max_slope:
                    return nx, ny
        return x, y

    def reset(self, seed: Optional[int] = None
              ) -> Tuple[Dict[str, np.ndarray], Dict[str, Any]]:
        if seed is not None:
            self.seed = seed
            self.rng = np.random.default_rng(seed)

        # 随机化（20.5）：摩擦 ±20%、尘暴、地方时、初始位姿抖动
        rand = self.training.get("randomization", {})
        fric = rand.get("friction", "±20%")
        spread = 0.2
        if isinstance(fric, str):
            fric = fric.replace("±", "").replace("%", "")
            try:
                spread = abs(float(fric)) / 100.0
            except ValueError:
                spread = 0.2
        self.friction_mult = float(self.rng.uniform(1 - spread, 1 + spread))
        tau = rand.get("dust_tau", [0.3, 1.5])
        self.dust_tau = float(self.rng.uniform(tau[0], tau[1]))
        hour = rand.get("local_hour", [8, 16])
        self.local_hour = float(self.rng.uniform(hour[0], hour[1]))

        self.rover = RoverModel(self.terrain, friction_mult=self.friction_mult)
        self._reset_task_state()
        self.rover.faults = getattr(self, "fault_zones", [])

        st = RoverState()
        if self.type == "RECOVERY" and self.fault_zones:
            poly = self.fault_zones[0].polygon
            cx = sum(p[0] for p in poly) / len(poly)
            cy = sum(p[1] for p in poly) / len(poly)
            st.x = cx + float(self.rng.uniform(-2, 2))
            st.y = cy + float(self.rng.uniform(-2, 2))
            st.yaw = float(self.rng.uniform(-math.pi, math.pi))
        elif self.type == "SURVEY_PATH" and self.targets:
            # 从质心（三角区中心）出发驶向第一个顶点：若出生在顶点上，
            # 火星车「开始仿真即拍照」，没有行驶过程（实测反馈）。
            st.x = self.centroid[0] + float(self.rng.uniform(-1, 1))
            st.y = self.centroid[1] + float(self.rng.uniform(-1, 1))
            # 出生点防陡坡：质心若压在超限坡度上，前进指令全被拒，
            # 火星车原地空转直至超时（零照片）——就近找可行驶点
            st.x, st.y = self._nearest_drivable(st.x, st.y)
            goal = self.photo_verts[0] if self.photo_verts else self.escape
            st.yaw = math.atan2(goal[1] - st.y, goal[0] - st.x)
        elif self.type == "TRAVERSE" and self.targets:
            st.x = self.targets[0][0] + float(self.rng.uniform(-1, 1))
            st.y = self.targets[0][1] + float(self.rng.uniform(-1, 1))
            goal = self.targets[1] if len(self.targets) > 1 else self.escape
            st.yaw = math.atan2(goal[1] - st.y, goal[0] - st.x)
        elif self.type == "TARGETED_APPROACH" and self.targets:
            tx, ty = self.targets[0]
            bearing = float(self.rng.uniform(0, 2 * math.pi))
            dist = float(self.rng.uniform(10, 20))
            st.x = tx - dist * math.cos(bearing)
            st.y = ty - dist * math.sin(bearing)
            st.yaw = bearing
        self.state = st

        # 记录复位
        self.trajectory = []
        self.events = []
        self._last_sample_t = -1e9
        self._last_action = np.zeros(self.action_dim)
        self._last_vel = np.zeros(2)
        self._last_advance = 0.0
        self._terminated_reason = ""
        self.metrics = {}
        if self.type == "SURVEY_PATH":
            self.covered[:] = False
            self.photo_hold_timer = 0.0
        if self.type == "TRAVERSE":
            self.wp_index = 0
            self.hold_timer = 0.0
        if self.type == "TARGETED_APPROACH":
            self.hold_timer = 0.0
        if self.type == "RECOVERY":
            self._ever_out = False

        self._record()
        return self._obs(), self._info()

    # ------------------------------------------------------------ 观测

    def _lidar(self) -> np.ndarray:
        p = self.p
        n = int(p["lidar_rays"])
        rng = float(p["lidar_range_m"])
        step = float(p["lidar_step_m"])
        st = self.state
        # 前向 180° 扇区，居中于车头方向；批量射线一次算完
        angles = st.yaw + np.radians(-90 + 180 * np.arange(n) / (n - 1))
        xs = np.full(n, st.x, dtype=np.float64)
        ys = np.full(n, st.y, dtype=np.float64)
        d = self.terrain.raycast_many(xs, ys, angles, rng,
                                      float(p["eye_height"]), step)
        d += self.rng.normal(0, float(p["lidar_noise_m"]), n)
        return np.clip(d, 0.0, rng) / rng

    def _goal(self) -> Tuple[float, float]:
        if self.type == "TRAVERSE":
            if self.wp_index + 1 < len(self.targets):
                return self.targets[self.wp_index + 1]
            return self.targets[-1] if self.targets else (0.0, 0.0)
        if self.type == "TARGETED_APPROACH":
            return self._target
        if self.type == "SURVEY_PATH":
            # 目标为开环导航表上的下一个顶点（取模循环：走完一圈
            # 继续下一圈补覆盖，不会卡在自身所在顶点）
            if self.nav_pts:
                idx = (self.path_index + 1) % len(self.nav_pts)
                return self.nav_pts[idx]
            return (0.0, 0.0)
        return self.escape

    def _obs(self) -> Dict[str, np.ndarray]:
        st = self.state
        goal = self._goal()
        size = self.terrain.size_m
        dx = (goal[0] - st.x) / size
        dy = (goal[1] - st.y) / size
        desired = math.atan2(goal[1] - st.y, goal[0] - st.x)
        dyaw = _wrap_angle(desired - st.yaw) / math.pi

        prof = self.terrain.local_profile(st.x, st.y, st.yaw)
        slope = prof["slope"]
        # IMU：俯仰/横滚由局部坡度近似，角速度由上一步角速度近似
        pitch = math.sin(math.radians(slope))
        roll = 0.0
        yaw_rate = float(self._last_action[1]) if self.action_dim > 1 else 0.0

        # 缓存最近一次雷达扫描（实时帧直接复用，避免重复射线步进）
        self._last_lidar = self._lidar()

        return {
            "rel_pose": np.array([dx, dy, dyaw]),
            "vel": np.array(
                [float(self._last_vel[0]), float(self._last_vel[1])]),
            "imu": np.array([pitch, roll, yaw_rate]),
            "lidar": self._last_lidar,
            "ti_local": np.array(
                [prof["ti"], prof["ahead_ti"], prof["ahead_slope"] / 15.0]) / 3.0,
            "height_rel": np.array([prof["height"]
                                    / max(size * 0.1, 1e-6)]),
            "last_action": self._last_action.copy(),
        }

    def obs_vector(self) -> np.ndarray:
        obs = self._obs()
        return np.concatenate([np.ravel(v) for v in obs.values()])

    def _info(self) -> Dict[str, Any]:
        return {
            "time_s": self.state.time_s,
            "energy_wh": round(self.state.energy_wh, 4),
            "slip_ratio": round(self.state.slip_ratio, 3),
            "dust_tau": round(self.dust_tau, 3),
            "local_hour": round(self.local_hour, 2),
            "friction_mult": round(self.friction_mult, 3),
        }

    def progress(self) -> Dict[str, Any]:
        """任务进度摘要（供实时遥测面板显示）。"""
        st = self.state
        if self.type == "TRAVERSE":
            total = max(len(self.targets) - 1, 1)
            goal = self._goal()
            dist = math.hypot(goal[0] - st.x, goal[1] - st.y)
            return {
                "label": "途经点 %d/%d" % (self.wp_index + 1, total),
                "ratio": min(self.wp_index / total, 1.0),
                "dist_to_goal_m": round(dist, 1),
            }
        if self.type == "TARGETED_APPROACH":
            ph = getattr(self, "phase", "approach")
            if ph == "spinup":
                return {"label": "雷达起旋", "ratio": 0.0, "dist_to_goal_m": 0.0}
            if ph == "scan" and self._last_scan:
                cov = float(self._last_scan["coverage"])
                return {
                    "label": "雷达扫描 %.0f%%（第 %d 圈）"
                             % (cov * 100, int(self._last_scan["sweep"]) + 1),
                    "ratio": round(cov, 3),
                    "dist_to_goal_m": 0.0,
                }
            dist = math.hypot(self._target[0] - st.x, self._target[1] - st.y)
            return {
                "label": "抵近目标",
                "ratio": max(0.0, 1.0 - dist / 30.0),
                "dist_to_goal_m": round(dist, 1),
            }
        if self.type == "SURVEY_PATH":
            ratio = float(self.covered.mean()) if self.covered.size else 0.0
            return {
                "label": "勘测覆盖 %.0f%%" % (ratio * 100),
                "ratio": ratio,
                "dist_to_goal_m": None,
            }
        if self.type == "RECOVERY":
            in_zone = any(FaultZone.inside(z.polygon, st.x, st.y)
                          for z in self.fault_zones)
            dist = math.hypot(self.escape[0] - st.x, self.escape[1] - st.y)
            return {
                "label": "故障区内" if in_zone else "已出区",
                "ratio": None,
                "dist_to_goal_m": round(dist, 1),
            }
        return {"label": self.type, "ratio": None, "dist_to_goal_m": None}

    # ------------------------------------------------------------ 步进

    def set_v_scale(self, scale: float) -> None:
        """运行期调整线速度上限（v_max × scale）。

        env 与 RoverModel 各持一份 ENV_PARAMS 副本，步进时运动模型
        用自己的副本裁剪指令速度，因此两份必须同步设置，否则调速
        只影响遥测读数、不影响实际行驶。
        """
        v = float(ENV_PARAMS["v_max"]) * max(0.1, min(10.0, float(scale)))
        self.p["v_max"] = v
        self.rover.p["v_max"] = v

    def step(self, action: np.ndarray
             ) -> Tuple[Dict[str, np.ndarray], float, bool, bool,
                        Dict[str, Any]]:
        st = self.state
        act = np.asarray(action, dtype=np.float64).ravel()
        lin = float(np.clip(act[0], -1.0, 1.0))
        ang = float(np.clip(act[1], -1.0, 1.0))
        photo = bool(act[2] > 0.5) if self.action_dim > 2 else False
        v_cmd = lin * float(self.p["v_max"])
        w_cmd = ang * float(self.p["w_max"])
        self._last_action = act[: self.action_dim].copy()
        # 记录归一化指令速度，供 vel 观测与轨迹导出使用
        self._last_vel = np.array([lin, ang])

        prev_dist = math.hypot(self._goal()[0] - st.x, self._goal()[1] - st.y)

        info_step = self.rover.step(st, v_cmd, w_cmd, self.max_slope,
                                    self.climb_slope)
        # 记录本步实际前进量（米）：供 SSE v_actual 与轮子驱动使用
        self._last_advance = float(info_step.advance_m)
        for ev in info_step.events:
            self.events.append({"t": round(st.time_s, 2), "type": ev})

        reward = 0.0
        w = self.reward_w
        terminated = False
        truncated = False

        # 稠密进步奖励（防止稀疏奖励样本效率过低）
        dist = math.hypot(self._goal()[0] - st.x, self._goal()[1] - st.y)
        reward += w["progress"] * (prev_dist - dist)
        reward += w["time"] * float(self.p["dt"])

        for ev in info_step.events:
            if ev == "collision":
                reward += w["collision"]
            elif ev == "slope_violation":
                reward += w["slope"]
            elif ev == "stuck":
                # 顶点停车对准/保持期间不算卡死：到位后可能需要原地
                # 转向对准质心，此期间前进指令无效属正常；若计 stuck
                # 会「到达最后顶点即终止、最后一张拍不到」（实测反馈）。
                at_photo_hold = False
                if self.type == "SURVEY_PATH" and self.photo_verts:
                    for k2, (vx2, vy2) in enumerate(self.photo_verts):
                        if self.photo_done[k2]:
                            continue
                        if math.hypot(vx2 - st.x, vy2 - st.y) \
                                <= self.photo_tol:
                            des2 = math.atan2(self.centroid[1] - st.y,
                                              self.centroid[0] - st.x)
                            if abs(_wrap_angle(des2 - st.yaw)) <= self.tol_yaw:
                                at_photo_hold = True
                            break
                if not at_photo_hold:
                    terminated = True
                    self._terminated_reason = "stuck"

        # 倾覆终止：横坡超限（以总坡度近似）
        if info_step.slope_deg > float(self.p["tipover_slope_deg"]):
            terminated = True
            self._terminated_reason = "flip"
            self.events.append({"t": round(st.time_s, 2), "type": "flip"})

        # 任务状态机
        if not terminated:
            terminated, task_reward = self._update_task(photo)
            reward += task_reward

        # 时限
        if st.time_s >= self.time_budget:
            truncated = True
            if not self._terminated_reason:
                self._terminated_reason = "timeout"

        self._record()
        info = self._info()
        info["terminated_reason"] = self._terminated_reason
        return self._obs(), reward, terminated, truncated, info

    def _update_task(self, photo: bool) -> Tuple[bool, float]:
        """任务状态机推进，返回 (terminated, task_reward)。"""
        st = self.state
        w = self.reward_w
        reward = 0.0

        if self.type == "TRAVERSE":
            if self.wp_index + 1 >= len(self.targets):
                return True, w["arrive"]
            goal = self.targets[self.wp_index + 1]
            dist = math.hypot(goal[0] - st.x, goal[1] - st.y)
            desired = math.atan2(goal[1] - st.y, goal[0] - st.x)
            in_tol = dist <= self.tol_pos and \
                abs(_wrap_angle(desired - st.yaw)) <= self.tol_yaw
            if in_tol:
                self.hold_timer += float(self.p["dt"])
                if self.hold_timer >= self.hold_time:
                    self.wp_index += 1
                    self.hold_timer = 0.0
                    reward += w["arrive"]
            else:
                self.hold_timer = 0.0
            return False, reward

        if self.type == "TARGETED_APPROACH":
            if getattr(self, "phase", "approach") == "spinup":
                # 起旋：车体原地旋转数秒（雷达展开），再开始扫描。
                # 同步推送 radar 帧（phase=spinup）供前端显示扫描区域高亮。
                self._last_scan = {
                    "coverage": 0.0, "sweep": 0,
                    "angle": float(st.yaw), "points": [],
                    "phase": "spinup",
                }
                self.hold_timer += float(self.p["dt"])
                if self.hold_timer >= float(self.p["radar_spinup_s"]):
                    self.phase = "scan"
                    self.scanner = RadarScanner(self.p)
                    self.hold_timer = 0.0
                    self.events.append({"t": round(st.time_s, 2),
                                        "type": "scan_start"})
                return False, reward
            if getattr(self, "phase", "approach") == "scan":
                # 雷达成像阶段：斜向下扫视 10 m 半径地形。完成条件为
                # **扫满 360° 一整圈**（coverage 仅作报告指标——80% 不是
                # 终止条件，避免「转到 80% 就停」）；扫满兜底圈数仍未
                # wrap 时按部分完成结束（理论上不会发生）。
                info = self.scanner.step(
                    self.terrain, st.x, st.y, st.yaw,
                    self.terrain.height_at(st.x, st.y),
                    float(self.p["dt"]), self.rng)
                info["phase"] = "scan"
                self._last_scan = info
                if info["sweep"] >= 1:
                    self.scan_result = self.scanner.export_map()
                    self.phase = "done"
                    self.events.append({"t": round(st.time_s, 2),
                                        "type": "scan_complete"})
                    return True, w["arrive"]
                if info["sweep"] >= self.scanner.max_sweeps:
                    self.scan_result = self.scanner.export_map()
                    self.phase = "done"
                    self._terminated_reason = "scan_partial"
                    self.events.append({"t": round(st.time_s, 2),
                                        "type": "scan_partial"})
                    return True, w["arrive"]
                return False, reward
            tx, ty = self._target
            dist = math.hypot(tx - st.x, ty - st.y)
            desired = math.atan2(self._orient[1] - ty, self._orient[0] - tx)
            in_tol = dist <= self.tol_pos and \
                abs(_wrap_angle(desired - st.yaw)) <= self.tol_yaw
            if in_tol:
                self.hold_timer += float(self.p["dt"])
                if self.hold_timer >= self.hold_time:
                    # 到位保持完成 → 起旋（车先转起来，再开始扫描）
                    self.phase = "spinup"
                    self.hold_timer = 0.0
                    self.events.append({"t": round(st.time_s, 2),
                                        "type": "radar_deploy"})
                    return False, 0.0
            else:
                self.hold_timer = 0.0
            return False, reward

        if self.type == "SURVEY_PATH":
            # 推进路径进度指针（开环取模：到点即 advancing，循环巡查）
            if self.nav_pts:
                nxt = self.nav_pts[(self.path_index + 1) % len(self.nav_pts)]
                if math.hypot(nxt[0] - st.x, nxt[1] - st.y) <= self.survey_radius:
                    self.path_index = (self.path_index + 1) % len(self.nav_pts)
            # 顶点拍照：位于未拍顶点容差内、且相机光轴指向质心时，
            # photo 动作通道触发即记为一次成功成像（3 顶点共 3 张）
            if photo:
                # 拍照时机（实测反馈：车还没转过去照片就出现）：
                # 同时满足 ①位于顶点容差内 ②光轴对准质心
                # ±photo_yaw_tol ③停车保持 photo_hold_s 才成像；
                # 保持期间任一条件被打破立即重新计时。
                hit = -1
                for k, (vx, vy) in enumerate(self.photo_verts):
                    if self.photo_done[k]:
                        continue
                    if math.hypot(vx - st.x, vy - st.y) > self.photo_tol:
                        continue
                    desired = math.atan2(self.centroid[1] - st.y,
                                         self.centroid[0] - st.x)
                    if abs(_wrap_angle(desired - st.yaw)) \
                            <= self.photo_yaw_tol:
                        hit = k
                        break
                stationary = abs(float(self._last_action[0])) < 0.05
                if hit >= 0 and stationary:
                    self.photo_hold_timer += float(self.p["dt"])
                else:
                    self.photo_hold_timer = 0.0
                if hit >= 0 and stationary and \
                        self.photo_hold_timer >= self.photo_hold_s:
                    self.photo_done[hit] = True
                    self.photos.append({
                        "vertex": hit,
                        "t": round(st.time_s, 2),
                        "x": round(st.x, 3),
                        "y": round(st.y, 3),
                        "yaw": round(st.yaw, 4),
                        "target_x": round(self.centroid[0], 3),
                        "target_y": round(self.centroid[1], 3),
                        "fov": self.fov,
                    })
                    self.events.append({"t": round(st.time_s, 2),
                                        "type": "photo_taken"})
                    self.photo_hold_timer = 0.0
                    reward += w["photo"]
            if photo:
                newly = 0.0
                for i, (px, py) in enumerate(self.cover_pts):
                    if self.covered[i]:
                        continue
                    if math.hypot(px - st.x, py - st.y) <= self.survey_radius:
                        self.covered[i] = True
                        newly += 2.0  # 采样间隔（米）
                reward += w["coverage"] * newly / 10.0
            ratio = float(self.covered.mean()) if self.covered.size else 0.0
            # 完成条件：3/3 顶点照片（覆盖率仅作记录指标）。此前要求
            # 覆盖达标，拍照完成后火星车会继续绕三角形转到达标为止，
            # 行为笨拙（实测反馈）——勘测任务以成像完成为目标。
            photos_ok = all(self.photo_done) if self.photo_verts else True
            if photos_ok:
                return True, w["arrive"]
            return False, reward

        if self.type == "RECOVERY":
            in_zone = any(FaultZone.inside(z.polygon, st.x, st.y)
                          for z in self.fault_zones)
            if not in_zone:
                self._ever_out = True
            dist = math.hypot(self.escape[0] - st.x, self.escape[1] - st.y)
            if self._ever_out and dist <= self.tol_pos:
                return True, w["escape"]
            return False, reward

        return False, reward

    # ------------------------------------------------------------ 记录

    def _record(self) -> None:
        st = self.state
        if st.time_s - self._last_sample_t < float(
                self.p["traj_decimate_s"]):
            return
        self._last_sample_t = st.time_s
        self.trajectory.append({
            "t": round(st.time_s, 2),
            "x": round(st.x, 3),
            "y": round(st.y, 3),
            "yaw": round(st.yaw, 4),
            "v": round(self._last_action[0], 3),
            "w": round(self._last_action[1], 3),
            "energy_wh": round(st.energy_wh, 4),
        })

    def finalize(self) -> Dict[str, Any]:
        """结束 episode，计算指标（含 SPL 最优路径基准）。"""
        st = self.state
        pts = [(s["x"], s["y"]) for s in self.trajectory]
        path_len = sum(math.hypot(b[0] - a[0], b[1] - a[1])
                       for a, b in zip(pts, pts[1:]))
        optimal = None
        if self.type in ("TRAVERSE", "RECOVERY") and self.targets:
            waypoints = [pts[0]] + self.targets if pts else self.targets
            if self.type == "RECOVERY":
                waypoints = [pts[0], self.escape] if pts else [self.escape]
            optimal = path_lengths(self.terrain, waypoints)
        spl = (optimal / path_len) if (optimal and path_len > 1e-6) else None

        success = self._terminated_reason == ""
        self.metrics = {
            "type": self.type,
            "seed": self.seed,
            "success": success,
            "terminated_reason": self._terminated_reason or "completed",
            "time_s": round(st.time_s, 2),
            "path_len_m": round(path_len, 2),
            "optimal_len_m": round(optimal, 2) if optimal else None,
            "spl": round(spl, 4) if spl else None,
            "energy_wh": round(st.energy_wh, 4),
            "collisions": sum(1 for e in self.events
                              if e["type"] == "collision"),
            "slip_events": sum(1 for e in self.events if e["type"] == "slip"),
            "slope_violations": sum(1 for e in self.events
                                    if e["type"] == "slope_violation"),
            "coverage": round(float(self.covered.mean()), 4)
            if self.type == "SURVEY_PATH" and self.covered.size else None,
            "photos_taken": len(self.photos)
            if self.type == "SURVEY_PATH" else None,
            "scan_coverage": round(float(self._last_scan["coverage"]), 4)
            if self.type == "TARGETED_APPROACH" and self._last_scan else None,
            "scan_points": len(self.scanner.points)
            if self.type == "TARGETED_APPROACH" and self.scanner else None,
            "scan_sweeps": int(self._last_scan["sweep"])
            if self.type == "TARGETED_APPROACH" and self._last_scan else None,
        }
        return self.metrics

    def export_trajectory(self, mission_id: str = "") -> Dict[str, Any]:
        """导出轨迹 JSON（供前端回放与评测报告）。"""
        return {
            "mission_id": mission_id,
            "activity_id": self.activity.get("id", ""),
            "type": self.type,
            "region": self.region,
            "seed": self.seed,
            "metrics": self.metrics or self.finalize(),
            "events": self.events,
            "targets": [
                {"x": t[0], "y": t[1]} for t in self.targets
            ],
            "fov": self.fov if self.type == "SURVEY_PATH" else None,
            # SURVEY_PATH：顶点拍照记录（位姿/朝向/质心，供前端渲染照片）
            "photos": self.photos if self.type == "SURVEY_PATH" else None,
            # TARGETED_APPROACH：雷达成像结果（10 m 半径地形图）
            "radar_map": (self.scan_result
                          if self.type == "TARGETED_APPROACH" else None),
            "samples": self.trajectory,
        }
