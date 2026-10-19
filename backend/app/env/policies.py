"""脚本基线策略（用于无模型验证环境闭环与回放演示）。

Pure-pursuit 航点跟踪：朝当前目标点转向、按距离调速、到位前减速。
它不聪明，但足以验证环境的状态机、判据与指标计算正确，
并为前端回放提供轨迹数据。RL 策略未来在同一接口下替换即可。
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

# 逃逸转向候选（相对车头偏移，rad）
_ESCAPE_OFFSETS = (0.5, -0.5, 1.0, -1.0, 1.6, -1.6)


def _wrap(a: float) -> float:
    while a > math.pi:
        a -= 2 * math.pi
    while a < -math.pi:
        a += 2 * math.pi
    return a


def _current_goal(env) -> Tuple[float, float]:
    """与环境内部目标选择保持一致。"""
    if env.type == "TRAVERSE":
        if env.wp_index + 1 < len(env.targets):
            return env.targets[env.wp_index + 1]
        return env.targets[-1] if env.targets else (0.0, 0.0)
    if env.type == "TARGETED_APPROACH":
        return env._target
    if env.type == "SURVEY_PATH":
        # 开环取模循环（与环境 _goal 一致）
        nav = getattr(env, "nav_pts", [])
        if nav:
            return nav[(env.path_index + 1) % len(nav)]
        return (0.0, 0.0)
    return env.escape


class ScriptedPursuitPolicy:
    """航点跟踪基线 + 局部避障规划。

    白盒 agent：pure pursuit 跟踪环境目标，并用地形栅格做前视
    空闲方向探测绕开巨石（脚本基线允许访问地图先验；RL 策略
    只能使用激光观测，届时需学习同样的避障行为）。

    激光避障作为兜底：正前方 3 m 内有障碍时后退转向。
    """

    def __init__(self, env):
        self.env = env
        self._photo_cool = 0.0
        self._blocked_t = 0.0   # 全向被堵累计时长（脱困升级用）
        self._spin_dir = 1.0    # 原地掉头方向
        self._tried_yaws: List[float] = []  # 已试过的逃逸航向（绝对角）

    def _heading_clear(self, x: float, y: float, yaw_off: float,
                       dists: Tuple[float, ...] = (0.5, 1.0)) -> bool:
        """相对车头 yaw_off 的方向上，车体截面走廊是否可通行。

        不可通行条件：越界、巨石类别、坡度超过任务 max_slope。
        坡度必须探：环境对超坡指令拒绝执行（记违规），基线若不看
        坡度会在陡坡前持续指令前进且零位移，被误判为卡死。

        每个距离探测 3 点（中心 + 垂直方向 ±0.5 m）而非单点：
        碰撞判定查的是正前 0.5 m 的单格，而语义栅格 1.95 m/px、
        巨石簇很小，单点探针会与判定点错开半个车身，出现「策略
        认为可通行、模型判定碰撞」的反复顶撞。走廊探测与车体
        0.56 m 直径匹配，从根上消除错位。

        车体已落在巨石像素上时忽略巨石探测：运动模型有 on_boulder
        例外（允许从巨石上驶离，否则车会被自己压着的巨石困死），
        策略须与之一致，否则会出现「四周皆石 → 原地打转」（实测
        反馈：车停上巨石带后原地旋转、位移为零）。
        """
        terr = self.env.terrain
        a = self.env.state.yaw + yaw_off
        ca, sa = math.cos(a), math.sin(a)
        px, py = -sa, ca  # 垂直方向
        on_boulder = terr.sem_at(x, y) == 3
        limit = getattr(self.env, "climb_slope", self.env.max_slope)
        block_h = float(self.env.p["boulder_block_h"])
        for d in dists:
            for off in (-0.5, 0.0, 0.5):
                ax = x + d * ca + off * px
                ay = y + d * sa + off * py
                if not terr.in_bounds(ax, ay):
                    return False
                # 只把「够高的岩体」当封路障碍；低矮碎石可直接碾过
                # （与环境侧 is_boulder_blocking 判据一致）
                if not on_boulder and \
                        terr.is_boulder_blocking(ax, ay, block_h):
                    return False
                if terr.slope_at(ax, ay) > limit:
                    return False
        return True

    def _is_tried(self, yaw: float) -> bool:
        """该绝对航向是否已作为逃逸方向试过（±0.45 rad 内视为同一）。"""
        return any(abs(_wrap(yaw - t)) < 0.45 for t in self._tried_yaws)

    def act(self, obs: Dict[str, np.ndarray]) -> np.ndarray:
        env = self.env
        st = env.state
        lin = 0.0
        ang = 0.0
        photo = 0.0

        if env.type == "TARGETED_APPROACH":
            # 雷达成像两阶段：
            # spinup——车体原地全速旋转（雷达展开），先转起来；
            # scan——车体以雷达扫描角速度同步旋转，边转边扫 360°。
            phase = getattr(env, "phase", "approach")
            if phase == "spinup":
                return np.array([0.0, 1.0])
            if phase == "scan":
                sweep_w = 2.0 * math.pi / float(env.p["radar_sweep_s"])
                ang = float(np.clip(sweep_w / float(env.p["w_max"]),
                                    -1.0, 1.0))
                return np.array([0.0, ang])
            # 两段式：接近到 0.8×tol_pos（留出保持余量）后停车对准。
            # 阈值取 0.8 倍而非 tol 本身：若在 tol 边界处停车，
            # 朝向未对准时无法继续微前进位，会死锁在边界外。
            tx, ty = env._target
            dist = math.hypot(tx - st.x, ty - st.y)
            desired_yaw = math.atan2(env._orient[1] - ty,
                                     env._orient[0] - tx)
            if dist > env.tol_pos * 0.8:
                yaw_err = _wrap(math.atan2(ty - st.y, tx - st.x) - st.yaw)
                speed = min(0.3, dist / 5.0)
                if abs(yaw_err) > math.pi / 8:
                    speed *= 0.35
                lin, ang = speed, float(np.clip(yaw_err * 1.5, -1.0, 1.0))
            else:
                yaw_err = _wrap(desired_yaw - st.yaw)
                lin, ang = 0.0, float(np.clip(yaw_err * 2.0, -1.0, 1.0))
        elif env.type == "SURVEY_PATH":
            # 顶点拍照优先：导航到最近的未拍顶点，到位后停车并把
            # 相机光轴对准质心，持续触发成像通道
            pend = [v for k, v in enumerate(env.photo_verts)
                    if not env.photo_done[k]]
            if pend:
                vx, vy = min(pend,
                             key=lambda p: math.hypot(p[0] - st.x,
                                                      p[1] - st.y))
                dv = math.hypot(vx - st.x, vy - st.y)
                to_cen = math.atan2(env.centroid[1] - st.y,
                                    env.centroid[0] - st.x)
                yaw_cen = _wrap(to_cen - st.yaw)
                if dv > env.photo_tol * 0.8:
                    # 驶向顶点：常规车速（拍照是停车动作，不必慢速），
                    # 航向偏差大时降速避免画大圆弧
                    yaw_err = _wrap(math.atan2(vy - st.y, vx - st.x) - st.yaw)
                    speed = min(1.0, dv / 5.0)
                    if abs(yaw_err) > math.pi / 3:
                        speed = 0.0
                    elif abs(yaw_err) > math.pi / 8:
                        speed *= 0.35
                    lin, ang = speed, float(np.clip(yaw_err * 1.5, -1.0, 1.0))
                else:
                    if abs(yaw_cen) <= env.photo_yaw_tol:
                        # 已对准质心：停转稳住车体，满足环境侧的
                        # 拍照保持计时（边转边拍不计时）
                        lin, ang = 0.0, 0.0
                    else:
                        lin, ang = 0.0, float(np.clip(yaw_cen * 2.0, -1.0, 1.0))
                photo = 1.0 if (dv <= env.photo_tol
                                and abs(yaw_cen) <= env.photo_yaw_tol) else 0.0
                # 拍照保持期（已进入顶点容差圈）：停稳优先，直接返回、
                # 绕过下方避障覆盖。否则 Lidar/地形避障会持续指令
                # 前进/后退/转向，环境侧 0.6s 停车保持计时永远攒不满，
                # 表现为「到顶点、转正了却不拍照」；顶着障碍指令前进
                # 3s 还会触发 stuck 直接终止任务（实测反馈）。
                if dv <= env.photo_tol:
                    if abs(yaw_cen) <= env.photo_yaw_tol:
                        return np.array([0.0, 0.0, 1.0])
                    return np.array(
                        [0.0, float(np.clip(yaw_cen * 2.0, -1.0, 1.0)), 0.0])
            else:
                # 顶点拍完后沿闭合路径补覆盖（原有逻辑）
                goal = _current_goal(env)
                dx, dy = goal[0] - st.x, goal[1] - st.y
                dist = math.hypot(dx, dy)
                desired = math.atan2(dy, dx)
                yaw_err = _wrap(desired - st.yaw)
                speed = min(1.0, dist / 5.0)
                if abs(yaw_err) > math.pi / 3:
                    speed = 0.0
                elif abs(yaw_err) > math.pi / 8:
                    speed *= 0.35
                lin, ang = speed, float(np.clip(yaw_err * 1.5, -1.0, 1.0))
                # 沿路径每约 10 m 触发一次成像
                self._photo_cool -= env.p["dt"]
                photo = 1.0 if self._photo_cool <= 0 else 0.0
                if photo:
                    self._photo_cool = 10.0
        else:
            goal = _current_goal(env)
            dx, dy = goal[0] - st.x, goal[1] - st.y
            dist = math.hypot(dx, dy)
            desired = math.atan2(dy, dx)
            yaw_err = _wrap(desired - st.yaw)
            speed = min(1.0, dist / 5.0)
            if abs(yaw_err) > math.pi / 3:
                speed = 0.0
            elif abs(yaw_err) > math.pi / 8:
                speed *= 0.35
            lin, ang = speed, float(np.clip(yaw_err * 1.5, -1.0, 1.0))

        # 局部避障：正前方被巨石挡住时，探测空闲方向并转向；
        # 全方向皆堵时先原地掉头换方向，仍无出路再倒车脱困。
        # 激光兜底处理低于眼高的障碍。
        blocked = not self._heading_clear(st.x, st.y, 0.0)
        if blocked:
            cands = [o for o in _ESCAPE_OFFSETS
                     if self._heading_clear(st.x, st.y, o)]
            fresh = [o for o in cands if not self._is_tried(st.yaw + o)]
            if fresh:
                # 转向找路 + 低速蹭行：正前方完全不通时纯转向永远出
                # 不来（转到位仍被判堵、净位移恒为零）。给 0.2 的蹭行
                # 让车能贴着巨石挪出卡点；模型若真挡死则零位移，由
                # 卡死判定（3s）与下面的候选淘汰兜底。
                # 已试过的方向不再重选——巨石探测的离散误差会让
                # 「+0.5 rad 通、转一点又 −1.0 rad 通」，车体永远
                # 在两个方向间摆头（任务 kc 实测复现）。
                self._blocked_t = 0.0
                off = min(fresh, key=abs)
                self._tried_yaws.append(st.yaw + off)
                lin, ang = 0.2, float(np.clip(off * 1.5, -1.0, 1.0))
            elif cands:
                # 候选方向全部试过仍不通：清空重评（车体已转动，
                # 相对关系变了）
                self._tried_yaws.clear()
                self._blocked_t = 0.0
                lin, ang = 0.0, float(np.clip(cands[0] * 1.5, -1.0, 1.0))
            else:
                # 全向被堵：原地持续掉头（转动不需要净空，能换到新的
                # 采样方向），仍无出路且身后可通行时倒车脱困；掉头与
                # 倒车都无效时强推一次前进，把决策权交给卡死判定
                # （3s 无位移即终止并报 stuck），不再原地无限旋转。
                self._blocked_t += float(env.p["dt"])
                self._tried_yaws.clear()
                behind_ok = self._heading_clear(st.x, st.y, math.pi)
                if self._blocked_t < 2.0 or not behind_ok:
                    lin, ang = 0.0, self._spin_dir
                elif self._blocked_t <= 4.0 and behind_ok:
                    lin, ang = -1.0, 0.0
                else:
                    lin, ang = 0.3, 0.0
                    if self._blocked_t > 7.0:
                        self._blocked_t = 0.0
                        self._spin_dir = -self._spin_dir
        else:
            self._blocked_t = 0.0
            self._tried_yaws.clear()
            lidar = obs.get("lidar") if isinstance(obs, dict) else None
            if lidar is not None:
                d = np.asarray(lidar, dtype=np.float64) * float(
                    env.p["lidar_range_m"])
                n = d.shape[0]
                front = d[max(n // 2 - 3, 0): n // 2 + 4]
                near = float(front.min()) if front.size else 99.0
                # 上坡不是障碍：近处若只是可爬坡（坡度未超硬件能力、
                # 非巨石）就照常前进。否则车在任何缓坡前都会「后退」，
                # 后退到坡下又想上坡，净位移为零原地打转（实测反馈）。
                climb_ok = True
                if near < 3.0:
                    terr = env.terrain
                    ca, sa = math.cos(st.yaw), math.sin(st.yaw)
                    climb_ok = False
                    lim = getattr(env, "climb_slope", env.max_slope)
                    for dd in (1.0, 2.0, 2.5):
                        ax, ay = st.x + dd * ca, st.y + dd * sa
                        if terr.in_bounds(ax, ay) \
                                and terr.slope_at(ax, ay) <= lim \
                                and terr.sem_at(ax, ay) != 3:
                            climb_ok = True
                            break
                if near < 3.0 and not climb_ok:
                    left = float(d[: n // 3].mean())
                    right = float(d[-n // 3:].mean())
                    lin = -0.25
                    ang = 0.8 if left >= right else -0.8

        if env.type == "SURVEY_PATH":
            return np.array([lin, ang, photo])
        return np.array([lin, ang])


def run_episode(env, policy=None, max_steps: int = 100000
                ) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """跑一个完整 episode，返回 (metrics, trajectory)。"""
    obs, _ = env.reset()
    pol = policy or ScriptedPursuitPolicy(env)
    steps = 0
    while steps < max_steps:
        action = pol.act(obs)
        obs, _r, terminated, truncated, _info = env.step(action)
        steps += 1
        if terminated or truncated:
            break
    return env.finalize(), env.trajectory
