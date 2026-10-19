"""训练环境的地形数据提供（策划书 20.2 几何层 / 语义层）。

与 core.terrain_query 共用同一批栅格文件（height / classes / sem），
保证 surrogate 环境、Web 前端、Gazebo 导出三处对地形的理解一致；
区别在于本模块提供数组级访问（逐帧查询、射线求交），而非单点查询。
"""

from __future__ import annotations

import json
import math
from typing import Dict, Optional, Tuple

import numpy as np

from ..settings import region_dir

__all__ = ["RegionTerrain"]

# 语义编码（与 core.semantic / rover_model 一致）
SEM_NONE, SEM_SAND, SEM_BEDROCK, SEM_BOULDER, SEM_BASE = 0, 1, 2, 3, 4


class RegionTerrain:
    """区域地形栅格：高程（双线性）、类别（最近邻）、坡度与粗糙度。"""

    def __init__(self, name: str):
        meta_path = region_dir(name) / "region_meta.json"
        with open(meta_path, "r", encoding="utf-8") as fh:
            meta = json.load(fh)
        self.name = name
        self.size_m = float(meta["size_m"])
        self.n = int(meta["grids"]["interactive"])
        g = self.n

        def _read_bin(suffix: str, dtype) -> np.ndarray:
            raw = (region_dir(name) / (suffix % g)).read_bytes()
            return np.frombuffer(raw, dtype=dtype).reshape(g, g)

        self.height = _read_bin("height_%d.bin", np.float32).astype(np.float64)
        self.classes = _read_bin("classes_%d.u8", np.uint8)
        self.sem = _read_bin("sem_%d.u8", np.uint8)
        self.px = self.size_m / (g - 1)
        self._prom: Optional[np.ndarray] = None

    # ------------------------------------------------------------ 基础访问

    def _frac(self, x: float, y: float) -> Tuple[float, float]:
        half = self.size_m / 2.0
        fx = float(np.clip((x + half) / self.px, 0, self.n - 1))
        fy = float(np.clip((y + half) / self.px, 0, self.n - 1))
        return fx, fy

    def height_at(self, x: float, y: float) -> float:
        """双线性高程采样（米）。"""
        fx, fy = self._frac(x, y)
        x0, y0 = int(fx), int(fy)
        x1, y1 = min(x0 + 1, self.n - 1), min(y0 + 1, self.n - 1)
        tx, ty = fx - x0, fy - y0
        h00, h10 = self.height[y0, x0], self.height[y0, x1]
        h01, h11 = self.height[y1, x0], self.height[y1, x1]
        return (h00 * (1 - tx) + h10 * tx) * (1 - ty) + \
            (h01 * (1 - tx) + h11 * tx) * ty

    def _nearest(self, x: float, y: float) -> Tuple[int, int]:
        fx, fy = self._frac(x, y)
        return min(int(round(fx)), self.n - 1), min(int(round(fy)), self.n - 1)

    def ti_at(self, x: float, y: float) -> int:
        i, j = self._nearest(x, y)
        return int(self.classes[j, i])

    def sem_at(self, x: float, y: float) -> int:
        i, j = self._nearest(x, y)
        return int(self.sem[j, i])

    # ------------------------------------------------------------ 局部隆起

    @property
    def prominence(self) -> np.ndarray:
        """局部高程隆起栅格（米），懒计算并缓存。

        语义栅格里一个「巨石」格是 1.95 m × 1.95 m 的方块，比车体
        （0.56 m 宽）大 3.5 倍，若一律当作实心墙，视觉上只有几十厘米
        高的碎石也会拦路（实测：车被 0.197 m 隆起的碎石挡住原地
        打转 190 s）。因此用 DEM 高度区分「岩体」与「碎石」：
        隆起 = 中心格高程 − 外圈 7×7（去中心 3×3）平均高程。
        """
        if self._prom is None:
            self._prom = self._build_prominence()
        return self._prom

    def _build_prominence(self) -> np.ndarray:
        from numpy.lib.stride_tricks import sliding_window_view

        h = self.height
        n = h.shape[0]
        m = n - 6
        # 显式 reshape 后按轴求均值（兼容不接受 tuple 轴的 numpy 版本）
        outer = (sliding_window_view(h, (7, 7)).reshape(m, m, 49)
                 .mean(axis=-1))
        inner = (sliding_window_view(h, (3, 3)).reshape(n - 2, n - 2, 9)
                 .mean(axis=-1))
        ring = (outer * 49.0 - inner[1:1 + m, 1:1 + m] * 9.0) / 40.0
        prom = np.full((n, n), np.nan)
        prom[3:n - 3, 3:n - 3] = h[3:n - 3, 3:n - 3] - ring
        return prom

    def prominence_at(self, x: float, y: float) -> float:
        """局部隆起（米）；区域边缘无有效值时返回 0。"""
        i, j = self._nearest(x, y)
        v = self.prominence[j, i]
        return 0.0 if not np.isfinite(v) else float(v)

    def is_boulder_blocking(self, x: float, y: float,
                            min_height_m: float) -> bool:
        """该点是否为「必须绕行」的岩体（而非可碾过的碎石）。

        判据：语义为巨石，且局部隆起 ≥ min_height_m。实测巨石格
        隆起 92.8% < 0.5 m——绝大多数本就是碎石，碾过去即可。
        """
        if self.sem_at(x, y) != SEM_BOULDER:
            return False
        return self.prominence_at(x, y) >= min_height_m

    def in_bounds(self, x: float, y: float) -> bool:
        half = self.size_m / 2.0
        return abs(x) <= half and abs(y) <= half

    # ------------------------------------------------------------ 派生量

    def slope_at(self, x: float, y: float) -> float:
        """中心差分坡度（度）。"""
        fx, fy = self._frac(x, y)
        i, j = min(int(round(fx)), self.n - 1), min(int(round(fy)), self.n - 1)
        x0, x1 = max(i - 1, 0), min(i + 1, self.n - 1)
        y0, y1 = max(j - 1, 0), min(j + 1, self.n - 1)
        dE = (self.height[j, x1] - self.height[j, x0]) / max(x1 - x0, 1)
        dN = (self.height[y1, i] - self.height[y0, i]) / max(y1 - y0, 1)
        return float(np.degrees(np.arctan(np.hypot(dE, dN) / self.px)))

    def roughness_at(self, x: float, y: float) -> float:
        """3×3 邻域高程标准差（米）。"""
        i, j = self._nearest(x, y)
        r0, r1 = max(j - 1, 0), min(j + 2, self.n)
        c0, c1 = max(i - 1, 0), min(i + 2, self.n)
        return float(self.height[r0:r1, c0:c1].std())

    def local_profile(self, x: float, y: float, yaw: float,
                      ahead_m: float = 2.0) -> Dict[str, float]:
        """当前位置与前视点的地形概要（对应真车机载可通行性分析）。"""
        ax = x + ahead_m * np.cos(yaw)
        ay = y + ahead_m * np.sin(yaw)
        return {
            "height": self.height_at(x, y),
            "slope": self.slope_at(x, y),
            "ti": float(self.ti_at(x, y)),
            "sem": float(self.sem_at(x, y)),
            "ahead_height": self.height_at(ax, ay),
            "ahead_slope": self.slope_at(ax, ay),
            "ahead_ti": float(self.ti_at(ax, ay)),
        }

    def height_at_many(self, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        """向量化双线性高程采样（激光等逐帧批量查询用）。

        逐点循环调用 height_at 每步要数千次 numpy 标量运算，
        一局上万步会累计到十几分钟；本方法一次完成整批查询。
        """
        half = self.size_m / 2.0
        fx = np.clip((xs + half) / self.px, 0, self.n - 1)
        fy = np.clip((ys + half) / self.px, 0, self.n - 1)
        x0 = np.floor(fx).astype(np.int64)
        y0 = np.floor(fy).astype(np.int64)
        x1 = np.minimum(x0 + 1, self.n - 1)
        y1 = np.minimum(y0 + 1, self.n - 1)
        tx = fx - x0
        ty = fy - y0
        h00 = self.height[y0, x0]
        h10 = self.height[y0, x1]
        h01 = self.height[y1, x0]
        h11 = self.height[y1, x1]
        return (h00 * (1 - tx) + h10 * tx) * (1 - ty) + \
            (h01 * (1 - tx) + h11 * tx) * ty

    # ------------------------------------------------------------ 射线求交

    def raycast_many(self, xs: np.ndarray, ys: np.ndarray,
                     yaws: np.ndarray, max_range: float, eye_h: float,
                     step_m: float = 0.2) -> np.ndarray:
        """批量水平射线求交：返回每条射线的命中距离（未命中返回量程）。

        所有射线同步步进（每步一次向量化高程查询），语义与 raycast 一致：
        发射器高于起点地面 eye_h，地形高程超过该高度即命中；
        越界视为在越界距离处命中。
        """
        n = xs.shape[0]
        eye = self.height_at_many(xs, ys) + eye_h
        dist = np.full(n, max_range, dtype=np.float64)
        active = np.ones(n, dtype=bool)
        t = np.full(n, step_m, dtype=np.float64)
        half = self.size_m / 2.0
        steps = int(max_range / step_m)
        for _ in range(steps):
            idx = np.flatnonzero(active)
            if idx.size == 0:
                break
            tt = t[idx]
            hx = xs[idx] + tt * np.cos(yaws[idx])
            hy = ys[idx] + tt * np.sin(yaws[idx])
            inb = (np.abs(hx) <= half) & (np.abs(hy) <= half)
            hh = self.height_at_many(
                np.where(inb, hx, 0.0), np.where(inb, hy, 0.0))
            hit = (~inb) | (hh > eye[idx])
            if hit.any():
                dist[idx[hit]] = tt[hit]
                active[idx[hit]] = False
            t[idx] = tt + step_m
        return dist

    def raycast(self, x: float, y: float, yaw_rad: float, max_range: float,
                eye_h: float, step_m: float = 0.2) -> float:
        """单条射线（兼容保留；批量查询请用 raycast_many）。"""
        d = self.raycast_many(
            np.array([x], dtype=np.float64),
            np.array([y], dtype=np.float64),
            np.array([yaw_rad], dtype=np.float64),
            max_range, eye_h, step_m,
        )
        return float(d[0])

    def raycast_pitched(self, xs: np.ndarray, ys: np.ndarray,
                        yaws: np.ndarray, pitch_rad, max_range: float,
                        h0: float, step_m: float = 0.2) -> np.ndarray:
        """批量斜射线求交（雷达成像用）：返回每条射线的命中斜距。

        从 (x, y, 地面高程 + h0) 出发，沿水平角 yaw、俯角 pitch_rad
        （向下为正，可为标量或逐射线数组）步进；射线高程低于地形高程
        即命中，越界视为在越界距离处命中。未命中返回 max_range。

        与 raycast_many 的区别：射线带俯角，可测量「前方地面」而非
        只测障碍物侧面——雷达按环扫描时每环俯角 atan(H/r) 不同，
        故 pitch 必须是逐射线的。
        """
        xs = np.asarray(xs, dtype=np.float64)
        ys = np.asarray(ys, dtype=np.float64)
        yaws = np.asarray(yaws, dtype=np.float64)
        pitch = np.broadcast_to(np.asarray(pitch_rad, dtype=np.float64),
                                xs.shape)
        n = xs.shape[0]
        cp = np.cos(pitch)
        sp = np.sin(pitch)
        z0 = self.height_at_many(xs, ys) + h0
        dist = np.full(n, max_range, dtype=np.float64)
        active = np.ones(n, dtype=bool)
        t = np.full(n, step_m, dtype=np.float64)
        half = self.size_m / 2.0
        steps = int(max_range / step_m)
        for _ in range(steps):
            idx = np.flatnonzero(active)
            if idx.size == 0:
                break
            tt = t[idx]
            horiz = tt * cp[idx]
            hx = xs[idx] + horiz * np.cos(yaws[idx])
            hy = ys[idx] + horiz * np.sin(yaws[idx])
            ray_z = z0[idx] - tt * sp[idx]
            inb = (np.abs(hx) <= half) & (np.abs(hy) <= half)
            hh = self.height_at_many(
                np.where(inb, hx, 0.0), np.where(inb, hy, 0.0))
            hit = (~inb) | (hh > ray_z)
            if hit.any():
                dist[idx[hit]] = tt[hit]
                active[idx[hit]] = False
            t[idx] = tt + step_m
        return dist
