"""A* 路径规划（策划书 21.3 路径规划代价场 / 22.2 SPL 最优长度）。

在 TI 栅格上以 8 连通 A* 求起点到终点的最低代价路径，返回路径长度
（米）。SPL 指标需要"最短可行路径长度"作分母，即由本模块提供；
代价来自可通行性类别，禁行区不可通行。
"""

from __future__ import annotations

import heapq
import math
from typing import List, Optional, Tuple

import numpy as np

from .terrain import RegionTerrain

# TI 类别代价（与 21.3 节一致）
_COST = {0: 1.8, 1: 1.0, 2: 2.5, 3: 1e6}

# 搜索分辨率上限：1025² 全分辨率 A* 过慢，按 stride 降采样搜索，
# 得到的长度再按 stride 还原为米（路径拓扑不受影响）。
_STRIDE = 4


def _to_grid(t: RegionTerrain, x: float, y: float) -> Tuple[int, int]:
    half = t.size_m / 2.0
    gx = int(round((x + half) / t.px))
    gy = int(round((y + half) / t.px))
    gx = min(max(gx, 0), t.n - 1)
    gy = min(max(gy, 0), t.n - 1)
    return gx // _STRIDE, gy // _STRIDE


def astar_length(t: RegionTerrain, x0: float, y0: float,
                 x1: float, y1: float) -> Optional[float]:
    """起点到终点的最短可行路径长度（米）；不可达返回 None。"""
    n_ds = t.n // _STRIDE
    cls = t.classes[:: _STRIDE, :: _STRIDE][:n_ds, :n_ds]
    lut = np.array([_COST.get(i, 1.8) for i in range(256)])
    cost = lut[cls]
    # 垂直夸张与高程不影响水平路径长度，代价仅由类别决定
    step_m = t.px * _STRIDE

    sx, sy = _to_grid(t, x0, y0)
    ex, ey = _to_grid(t, x1, y1)

    def h(a, b):
        return math.hypot(a[0] - b[0], a[1] - b[1]) * step_m

    open_heap = [(0.0, (sx, sy))]
    g = {(sx, sy): 0.0}
    came = {}
    while open_heap:
        _, cur = heapq.heappop(open_heap)
        if cur == (ex, ey):
            break
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1),
                       (1, 1), (1, -1), (-1, 1), (-1, -1)):
            nx, ny = cur[0] + dx, cur[1] + dy
            if not (0 <= nx < n_ds and 0 <= ny < n_ds):
                continue
            c = cost[ny, nx]
            if c >= 1e5:
                continue
            step_len = step_m * (math.sqrt(2) if dx and dy else 1.0)
            ng = g[cur] + step_len * c
            if ng < g.get((nx, ny), 1e18):
                g[(nx, ny)] = ng
                came[(nx, ny)] = cur
                heapq.heappush(open_heap, (ng + h((nx, ny), (ex, ey)),
                                           (nx, ny)))
    if (ex, ey) not in g:
        return None
    # g 值含类别代价，还原为几何长度：逐段累计并除以平均代价的近似处理
    # 过粗；改为回溯路径点后累加几何长度
    path = [(ex, ey)]
    while path[-1] in came:
        path.append(came[path[-1]])
    path.reverse()
    length = 0.0
    for a, b in zip(path, path[1:]):
        length += math.hypot(b[0] - a[0], b[1] - a[1]) * step_m
    return length


def path_lengths(t: RegionTerrain,
                 waypoints: List[Tuple[float, float]]) -> Optional[float]:
    """依次经过各点的最短可行路径总长度（米）。"""
    total = 0.0
    for a, b in zip(waypoints, waypoints[1:]):
        seg = astar_length(t, a[0], a[1], b[0], b[1])
        if seg is None:
            return None
        total += seg
    return total
