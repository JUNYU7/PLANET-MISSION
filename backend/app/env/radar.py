"""抵近任务的雷达成像（TARGETED_APPROACH 扫描阶段）。

火星车到达目标并到位保持后，桅杆顶雷达斜向下 360° 扫视地面，绘制出
**以火星车为原点、10 m 半径**的地形图（0.5 m 栅格 + 命中点云），
扫描进度以栅格命中率衡量，达到 coverage_target（默认 80%）即完成。

几何模型（实测约束，勿随意改小安装高/环密度）：
- 雷达架在桅杆顶 H=2.5 m，**按环扫描**：半径 r 的环用俯角
  atan(H/r) 的波束（平坦地面恰好落在 r 处），标称俯角 35° 即
  r ≈ 3.6 m 的主束。单束 35° 从 0.6 m 车高只能覆盖约 1 m，要覆盖
  10 m 半径必须抬高安装点并按环调俯角；
- 近场 blind_m（1.5 m）以内几何不可观测，覆盖率统计予以剔除；
- 波束随扫描圈实时推进（sweep_s 秒一圈），命中斜距叠加高斯噪声
  （雷达测距而非测位置），再由带噪斜距解算地面点写入栅格。

坐标约定与 RoverEnv 一致：世界 x 东、y 南（北为 -y）；输出点云与
栅格均为**相对火星车原点**的 (dx 东, dy 南, dz 相对火星车地面)。
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Tuple

import numpy as np

__all__ = ["RadarScanner"]


class RadarScanner:
    """单次抵近任务的雷达地形扫描器（到位后创建，随任务步进而推进）。"""

    def __init__(self, params: Dict[str, Any]):
        self.range_m = float(params["radar_range_m"])
        self.height_m = float(params["radar_height_m"])
        self.pitch_nom = math.radians(float(params["radar_pitch_deg"]))
        self.ring_m = float(params["radar_ring_m"])
        self.blind_m = float(params["radar_blind_m"])
        self.rays = int(params["radar_rays"])
        self.sweep_s = float(params["radar_sweep_s"])
        self.step_m = float(params["radar_step_m"])
        self.noise_m = float(params["radar_noise_m"])
        self.grid_m = float(params["radar_grid_m"])
        self.radius_m = float(params["radar_map_radius_m"])
        self.coverage_target = float(params["radar_coverage_target"])
        self.max_sweeps = int(params["radar_max_sweeps"])

        self.az_step = 2.0 * math.pi / self.rays  # 方位角步进（弧度）
        n_rings = int(round((self.radius_m - self.blind_m) / self.ring_m)) + 1
        self.rings = self.blind_m + self.ring_m * np.arange(n_rings)
        # 每环俯角：平坦地面恰好落在该环半径处（atan(H/r)）
        self.pitches = np.arctan2(self.height_m, self.rings)
        self._emit_debt = 0.0   # 方位发射累计（按 az_step 归一化）
        self.angle = 0.0        # 当前扫描方位角（相对车头，弧度）
        self.sweeps = 0         # 已完成圈数

        # 地形栅格（相对火星车原点）：index i→dx 东，j→dy 南，中心对齐
        self.n = int(round(2.0 * self.radius_m / self.grid_m)) + 1
        self.grid = np.full((self.n, self.n), np.nan, dtype=np.float64)
        c = (np.arange(self.n) - (self.n - 1) / 2.0) * self.grid_m
        gx, gy = np.meshgrid(c, c)  # gx: dx 东, gy: dy 南
        rr = np.hypot(gx, gy)
        self.mask = (rr <= self.radius_m) & (rr >= self.blind_m)
        self.n_effective = int(self.mask.sum())
        self.points: List[Tuple[float, float, float]] = []

    # ------------------------------------------------------------ 扫描推进

    @property
    def coverage(self) -> float:
        """栅格命中率（已命中 / 可观测栅格数）。"""
        if self.n_effective <= 0:
            return 0.0
        filled = int(np.isfinite(self.grid[self.mask]).sum())
        return filled / float(self.n_effective)

    def step(self, terrain, x: float, y: float, yaw: float, ground_z: float,
             dt: float, rng: np.random.Generator) -> Dict[str, Any]:
        """推进一个控制步（dt 秒），返回本步新增点与扫描状态。

        每步按 sweep_s 推进扫描方位角；累计到一个方位步进就发射一整轮
        环束（每环一条斜射线，一次向量化求交），命中点（含测距噪声）
        写入栅格与点云。
        """
        span = 2.0 * math.pi * dt / self.sweep_s
        self._emit_debt += span / self.az_step
        n_az = int(self._emit_debt)
        self._emit_debt -= n_az

        new_points: List[Tuple[float, float, float]] = []
        if n_az > 0:
            rel = self.angle + np.arange(n_az) * self.az_step
            self.angle += n_az * self.az_step
            if self.angle >= 2.0 * math.pi:
                self.angle -= 2.0 * math.pi
                self.sweeps += 1
            abs_ang = yaw + rel  # 相对车头的方位 → 世界方位（x 东, y 南）

            # 环 × 方位全组合一次向量化斜射线求交
            n_rings = self.rings.shape[0]
            xs = np.repeat(np.full(n_az, x, dtype=np.float64), n_rings)
            ys = np.repeat(np.full(n_az, y, dtype=np.float64), n_rings)
            ang = np.tile(abs_ang, n_rings)
            pitch = np.repeat(self.pitches, n_az)
            d = terrain.raycast_pitched(xs, ys, ang, pitch, self.range_m,
                                        self.height_m, self.step_m)
            # 雷达测距噪声 → 由带噪斜距解算地面点
            d_meas = np.clip(d + rng.normal(0.0, self.noise_m, d.shape[0]),
                             self.step_m, self.range_m)
            px = xs + d_meas * np.cos(pitch) * np.cos(ang)
            py = ys + d_meas * np.cos(pitch) * np.sin(ang)
            pz = (ground_z + self.height_m) - d_meas * np.sin(pitch)
            dx, dy, dz = px - x, py - y, pz - ground_z
            self._write_grid(dx, dy, dz)
            for k in range(dx.shape[0]):
                pt = (float(dx[k]), float(dy[k]), float(dz[k]))
                self.points.append(pt)
                new_points.append(pt)

        return {
            "points": new_points,
            "coverage": self.coverage,
            "sweep": self.sweeps,
            "angle": float(yaw + self.angle),
        }

    def _write_grid(self, dx: np.ndarray, dy: np.ndarray,
                    dz: np.ndarray) -> None:
        """把命中点写入 0.5 m 栅格（多点同格取均值）。"""
        half = self.radius_m
        i = np.round((dx + half) / self.grid_m).astype(np.int64)
        j = np.round((dy + half) / self.grid_m).astype(np.int64)
        ok = (i >= 0) & (i < self.n) & (j >= 0) & (j < self.n)
        for k in np.flatnonzero(ok):
            self.grid[j[k], i[k]] = dz[k]

    # ------------------------------------------------------------ 导出

    def export_map(self) -> Dict[str, Any]:
        """导出地形图（供 trajectory JSON 与前端可视化）。"""
        grid = [[None if math.isnan(v) else round(float(v), 3)
                 for v in row] for row in self.grid]
        return {
            "origin": "rover",
            "radius_m": self.radius_m,
            "cell_m": self.grid_m,
            "n": self.n,
            "axes": "i=dx 东, j=dy 南（北为 -y），值=相对火星车地面高程(m)",
            "coverage": round(self.coverage, 4),
            "sweeps": self.sweeps,
            "points": [[round(p[0], 3), round(p[1], 3), round(p[2], 3)]
                       for p in self.points],
            "grid": grid,
        }
