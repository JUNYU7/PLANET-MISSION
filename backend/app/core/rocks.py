"""程序化岩石场生成：为平滑地表补上真实碎石。

设计要点：

1. **单种子可复现**：全部随机参数来自调用方传入的同一个
   ``np.random.Generator``，同 seed 永远得到同一片岩石场，便于实验
   复现与差分调试。

2. **三处消费同一份实例清单**：高度场叠加、语义/通行掩膜覆写、
   正射影像绘制使用完全相同的 (x, y, r, h, rho, theta, p, shape)，
   保证栅格 bump、贴图明暗、前端 3D 网格三者位置与形状一致。

3. **源分辨率作业**：在 1 m/px 的 DTM 上直接叠加。半径 < 1 m 的岩块
   在栅格上仅占 1–2 px，但掩膜覆写（巨石/禁行）仍然精确；视觉细节
   由贴图绘制与前端 InstancedMesh 补足——三者同源，不会互相矛盾。

坐标约定与 ``raster_source.grid_offsets`` 一致：数组 row0 在北、
col0 在西；场景坐标 +X 东、+Y（实例的 y）南，单位米，范围
[-size_m/2, +size_m/2]。
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

__all__ = [
    "ROCKS_DEFAULTS",
    "generate_rocks",
    "stamp_mask",
    "paint_rocks_into_gray",
    "instances_payload",
]

# 配置默认值（可由区域配置覆盖）
ROCKS_DEFAULTS: Dict[str, Any] = {
    "enabled": False,
    "count": 1200,           # 目标岩石数量（4 km² 碎石场）
    "seed": 20261015,        # 固定种子：同 seed 完全复现
    "r_min_m": 0.08,         # 半径下限（碎石）
    "r_max_m": 0.45,         # 半径上限（偶见较大岩块）
    "h_factor": 0.60,        # 高径比基准：h = h_factor * r * U(0.5, 1.2)
    "slope_full_deg": 10.0,  # 坡度接受权重降到 0 的角度（越平越密）
    "cluster_prob": 0.35,    # 在已有岩石附近撒点的概率（碎石场成簇）
    "cluster_radius_m": 8.0, # 成簇撒点的半径范围（米）
    "min_gap_m": 0.15,       # 两石最小间距（边缘到边缘）
    "edge_margin_m": 3.0,    # 距场景边缘的最小距离
    "power_k": 2.0,          # 半径幂律指数：越大越偏小石块
}

# 高度场中 dome 的可见高度比例：前端 3D 网格底部下沉 0.35h 嵌入
# 地表，露出 0.65h；栅格 bump 取同一比例，两者顶部才对得齐。
FIELD_H_RATIO = 0.65


def _sample_radius(rng: np.random.Generator, cfg: Dict[str, Any]) -> float:
    """幂律偏小的半径采样：小石块远多于大石块，与真实碎石分布一致。"""
    r_min = float(cfg.get("r_min_m", ROCKS_DEFAULTS["r_min_m"]))
    r_max = float(cfg.get("r_max_m", ROCKS_DEFAULTS["r_max_m"]))
    k = float(cfg.get("power_k", ROCKS_DEFAULTS["power_k"]))
    u = rng.random() ** k
    return r_min * (r_max / r_min) ** u


def _place_centers(
    rng: np.random.Generator,
    cfg: Dict[str, Any],
    size_m: float,
    slope: Optional[np.ndarray],
) -> List[Tuple[float, float, float]]:
    """坡度加权 + 成簇的撒点。

    两条非均匀机制：

    1. **坡度加权**：候选点按局部坡度线性拒绝——坡度 0 全接受，
       超过 slope_full_deg 零接受，碎石因此自然地富集在平坦处；
    2. **成簇**：cluster_prob 的概率不在全域均匀取点，而是在一块
       已放置岩石的 cluster_radius 范围内取点，形成碎石场，避免
       棋盘式均匀分布。

    半径先采样再参与间距判定（大石周围留空更多），达到目标数量或
    尝试次数耗尽（目标数的 60 倍）即停。
    """
    n_target = int(cfg.get("count", ROCKS_DEFAULTS["count"]))
    gap = float(cfg.get("min_gap_m", ROCKS_DEFAULTS["min_gap_m"]))
    margin = float(cfg.get("edge_margin_m", ROCKS_DEFAULTS["edge_margin_m"]))
    slope_full = float(cfg.get("slope_full_deg",
                               ROCKS_DEFAULTS["slope_full_deg"]))
    cluster_prob = float(cfg.get("cluster_prob",
                                 ROCKS_DEFAULTS["cluster_prob"]))
    cluster_r = float(cfg.get("cluster_radius_m",
                              ROCKS_DEFAULTS["cluster_radius_m"]))
    half = size_m / 2.0
    n = slope.shape[0] if slope is not None else 0

    def slope_at(x: float, y: float) -> float:
        if slope is None or n == 0:
            return 0.0
        col = int((x / size_m + 0.5) * n)
        row = int((0.5 - y / size_m) * n)
        col = min(max(col, 0), n - 1)
        row = min(max(row, 0), n - 1)
        return float(slope[row, col])

    placed: List[Tuple[float, float, float]] = []
    max_tries = max(n_target * 60, 4000)
    for _ in range(max_tries):
        if len(placed) >= n_target:
            break
        r = _sample_radius(rng, cfg)
        lim = half - margin - r
        if lim <= 0:
            break
        if placed and rng.random() < cluster_prob:
            # 成簇：围绕一块已放置岩石撒点
            px, py, _pr = placed[int(rng.integers(len(placed)))]
            ang = rng.uniform(0.0, 2.0 * math.pi)
            dist = rng.uniform(1.5, cluster_r)
            x = px + math.cos(ang) * dist
            y = py + math.sin(ang) * dist
            if abs(x) > lim or abs(y) > lim:
                continue
        else:
            x = rng.uniform(-lim, lim)
            y = rng.uniform(-lim, lim)
        # 坡度加权拒绝：平地全收，陡坡零收
        w = 1.0 - slope_at(x, y) / slope_full if slope_full > 0 else 1.0
        if w <= 0.0 or rng.random() > w:
            continue
        ok = True
        for (qx, qy, qr) in placed:
            if math.hypot(qx - x, qy - y) < qr + r + gap:
                ok = False
                break
        if ok:
            placed.append((x, y, r))
    return placed


def _make_instance(
    rng: np.random.Generator,
    cfg: Dict[str, Any],
    idx: int,
    x: float,
    y: float,
    r: float,
) -> Dict[str, Any]:
    """为一块岩石采样全部形状参数。

    rho/theta 决定椭圆足迹；p 决定剖面（尖顶↔平顶）；h 为出露高度；
    dx/dy 为重心偏心（打破旋转对称）；rip 为顶面起伏强度（仅大石
    显著）；shape 是前端基础网格索引（0–7，与后端形状参数无关，
    只决定 3D 轮廓库的选用）。
    """
    h_factor = float(cfg.get("h_factor", ROCKS_DEFAULTS["h_factor"]))
    rho = rng.uniform(0.7, 1.3)
    theta = rng.uniform(0.0, math.pi)
    # 剖面指数偏小 → 平顶陡坡的块状轮廓（碎石被敲裂的岩块感），
    # 而非圆滑的 dome
    p = rng.uniform(0.35, 0.75)
    h = h_factor * r * rng.uniform(0.5, 1.2)
    dx = rng.uniform(-0.2, 0.2) * r
    dy = rng.uniform(-0.2, 0.2) * r
    rip = rng.uniform(0.0, 0.22) if r >= 0.8 else 0.0
    ph1 = rng.uniform(0.0, 2.0 * math.pi)
    ph2 = rng.uniform(0.0, 2.0 * math.pi)
    lobe = None
    if r >= 0.8 and rng.random() < 0.3:
        # 大石常伴小石：次瓣偏移 0.5–0.8r，半径 0.4–0.6r
        la = rng.uniform(0.0, 2.0 * math.pi)
        ld = rng.uniform(0.5, 0.8) * r
        lobe = {
            "dx": round(math.cos(la) * ld, 3),
            "dy": round(math.sin(la) * ld, 3),
            "r": round(rng.uniform(0.4, 0.6) * r, 3),
            "h": round(rng.uniform(0.45, 0.7), 3),
        }
    return {
        "id": idx,
        "x": round(x, 3),
        "y": round(y, 3),
        "r": round(r, 3),
        "h": round(h, 3),
        "rho": round(rho, 3),
        "theta": round(theta, 4),
        "p": round(p, 3),
        "dx": round(dx, 3),
        "dy": round(dy, 3),
        "rip": round(rip, 3),
        "ph1": round(ph1, 4),
        "ph2": round(ph2, 4),
        "lobe": lobe,
        "shape": idx % 8,
    }


def _lobe_profile(u: float, v: float, a: float, b: float,
                  h: float, p: float) -> float:
    """单瓣 dome：椭圆足迹 + 指数剖面，足迹外为 0。"""
    d2 = (u / a) ** 2 + (v / b) ** 2
    if d2 >= 1.0:
        return 0.0
    return h * (1.0 - d2) ** p


def _rock_height_at(rock: Dict[str, Any], px: float, py: float) -> float:
    """某场景坐标点处该岩石贡献的高度（主瓣 + 次瓣取 max）。

    高度乘以 FIELD_H_RATIO：前端 3D 网格下沉 0.35h 嵌入地表，露出
    0.65h，栅格 bump 取同一比例，两者顶部才对得齐。
    """
    ct = math.cos(rock["theta"])
    st = math.sin(rock["theta"])
    a = rock["r"] * rock["rho"]
    b = rock["r"] / rock["rho"]
    cx = rock["x"] + rock["dx"]
    cy = rock["y"] + rock["dy"]
    u = (px - cx) * ct + (py - cy) * st
    v = -(px - cx) * st + (py - cy) * ct
    val = _lobe_profile(u, v, a, b, rock["h"], rock["p"])
    if rock["rip"] > 0.0:
        # 顶面起伏：两个方向的正交正弦，限制在 ±rip 内
        k1 = 6.2832 / max(rock["r"], 0.2) * 1.3
        k2 = 6.2832 / max(rock["r"], 0.2) * 0.9
        mod = 1.0 + rock["rip"] * math.sin(k1 * u + rock["ph1"]) \
            * math.sin(k2 * v + rock["ph2"])
        val *= max(0.55, mod)
    lobe = rock.get("lobe")
    if lobe is not None:
        lu = px - cx - lobe["dx"]
        lv = py - cy - lobe["dy"]
        val = max(val, _lobe_profile(lu, lv, lobe["r"], lobe["r"],
                                     rock["h"] * lobe["h"], rock["p"]))
    return max(0.0, val * FIELD_H_RATIO)


def generate_rocks(
    height: np.ndarray,
    cfg: Dict[str, Any],
    pixel_m: float = 1.0,
    slope: Optional[np.ndarray] = None,
    size_m: Optional[float] = None,
    seed: Optional[int] = None,
) -> Dict[str, Any]:
    """在高度场上生成岩石场。

    参数
    ----
    height : (n, n) 源分辨率相对高程（米），不会被修改
    cfg : 区域 rocks 配置（缺失项取 ROCKS_DEFAULTS）
    pixel_m : 高度场像元尺寸（米），默认 1 m/px
    slope : 可选的源分辨率坡度场（度），用于陡坡避让
    size_m : 场景边长（米）；缺省按 ``height.shape[0] * pixel_m`` 推算
    seed : 覆盖 cfg 中的种子

    返回
    ----
    dict: ``height``（叠加岩石后的新高程）、``mask``（岩石足迹布尔掩膜）、
    ``instances``（JSON 可序列化的岩石参数清单）
    """
    merged = dict(ROCKS_DEFAULTS)
    merged.update({k: v for k, v in cfg.items() if v is not None})
    n = height.shape[0]
    if size_m is None:
        size_m = n * pixel_m
    rng = np.random.default_rng(
        seed if seed is not None else int(merged["seed"]))

    placed = _place_centers(rng, merged, size_m, slope)

    out = height.astype(np.float64, copy=True)
    mask = np.zeros(height.shape, dtype=bool)
    instances: List[Dict[str, Any]] = []

    # 每块岩石只在其足迹外接盒内计算（外接盒 ≤ 6×6 px，总成本可忽略）
    east = (np.arange(n) + 0.5) * pixel_m - size_m / 2.0   # col → 东向坐标
    north = size_m / 2.0 - (np.arange(n) + 0.5) * pixel_m  # row → 北向坐标

    for idx, (x, y, r) in enumerate(placed):
        rock = _make_instance(rng, merged, idx, x, y, r)
        instances.append(rock)
        reach = r * 1.35 + 0.5
        c0 = int(max(0, (x - reach + size_m / 2.0) / pixel_m))
        c1 = int(min(n - 1, (x + reach + size_m / 2.0) / pixel_m))
        r0 = int(max(0, (size_m / 2.0 - y - reach) / pixel_m))
        r1 = int(min(n - 1, (size_m / 2.0 - y + reach) / pixel_m))
        for rr in range(r0, r1 + 1):
            py = north[rr]
            for cc in range(c0, c1 + 1):
                dh = _rock_height_at(rock, east[cc], py)
                if dh > 0.0:
                    out[rr, cc] += dh
                    mask[rr, cc] = True

    return {"height": out, "mask": mask, "instances": instances}


def stamp_mask(
    instances: Sequence[Dict[str, Any]],
    grid: int,
    size_m: float,
) -> np.ndarray:
    """把岩石足迹直接印到目标分辨率栅格（语义/通行覆写用）。

    与对源掩膜做最近邻重采样相比，印签保证每块岩石至少占据一格：
    0.25 m 半径的小石在 1.95 m/px 的交互网格上只覆盖 1–2 个源像素，
    重采样会被整块丢弃（400 块仅存活 ~25%）；印签则以格点是否落在
    椭圆足迹内判定，足迹未含任何格点时保底标记中心所在格——对可通行性
    而言这是保守方向（多判一格禁行），视觉真相由贴图与前端 3D 网格承载。

    栅格格点坐标约定与消费端（core.terrain_query / env.terrain）一致：
    格点 (r, c) 的中心位于 (c*px - size/2, r*px - size/2)，
    px = size/(grid-1)，y 向南为正（与高度场 row0 在北、场景 +Z 南的
    约定在查询端口的换算一致）。印签必须与查询用同一约定，否则岩石
    会整体南北镜像（row 方向取反）或偏差半格，查询与仿真都打不中。
    """
    n = int(grid)
    px = size_m / max(n - 1, 1)
    east = np.arange(n) * px - size_m / 2.0
    south = np.arange(n) * px - size_m / 2.0
    mask = np.zeros((n, n), dtype=bool)
    for rock in instances:
        a = rock["r"] * rock["rho"]
        b = rock["r"] / rock["rho"]
        ox = rock["x"] + rock["dx"]
        oy = rock["y"] + rock["dy"]
        ct = math.cos(rock["theta"])
        st = math.sin(rock["theta"])
        reach = max(a, b)
        c0 = int(max(0, math.floor((ox - reach + size_m / 2.0) / px)))
        c1 = int(min(n - 1, math.ceil((ox + reach + size_m / 2.0) / px)))
        r0 = int(max(0, math.floor((oy - reach + size_m / 2.0) / px)))
        r1 = int(min(n - 1, math.ceil((oy + reach + size_m / 2.0) / px)))
        for rr in range(r0, r1 + 1):
            py = south[rr]
            for cc in range(c0, c1 + 1):
                ex = east[cc]
                u = (ex - ox) * ct + (py - oy) * st
                v = -(ex - ox) * st + (py - oy) * ct
                if (u / a) ** 2 + (v / b) ** 2 <= 1.0:
                    mask[rr, cc] = True
        # 名义坐标 (x, y) 所在格无条件标记：查询、任务面板与前端
        # 实例都用名义坐标定位岩石；偏心 dx/dy 只影响 dome 形状，
        # 不参与定位。中心贴近格界时仅靠足迹命中会漏判。
        cc = min(max(int(round((rock["x"] + size_m / 2.0) / px)), 0), n - 1)
        rr = min(max(int(round((rock["y"] + size_m / 2.0) / px)), 0), n - 1)
        mask[rr, cc] = True
    return mask


def paint_rocks_into_gray(
    gray: np.ndarray,
    instances: Sequence[Dict[str, Any]],
    size_m: float,
) -> np.ndarray:
    """把岩石绘制进灰度正射影像（任意方形栅格，源 0.25 m/px 最佳）。

    光照固定为西北向高位（火星北半球中纬上午的典型光照方向）：
    椭圆足迹内按朗伯着色压暗并提亮迎光面，足迹外保持原值。
    与高度场叠加使用同一组足迹参数，贴图明暗与栅格 bump 对齐。
    """
    out = gray.astype(np.float64, copy=True)
    n = out.shape[0]
    px = size_m / n
    east = (np.arange(n) + 0.5) * px - size_m / 2.0
    north = size_m / 2.0 - (np.arange(n) + 0.5) * px
    # 光源方向（场景坐标：+X 东、+Y 南；西北 = (-x, -y)，抬高约 53°）
    lx, ly, lz = -0.55, -0.55, 0.63
    ln = math.sqrt(lx * lx + ly * ly + lz * lz)
    lx, ly, lz = lx / ln, ly / ln, lz / ln

    for rock in instances:
        a = rock["r"] * rock["rho"]
        b = rock["r"] / rock["rho"]
        cx = rock["x"] + rock["dx"]
        cy = rock["y"] + rock["dy"]
        ct = math.cos(rock["theta"])
        st = math.sin(rock["theta"])
        reach = max(a, b) + 0.5
        c0 = int(max(0, (cx - reach + size_m / 2.0) / px))
        c1 = int(min(n - 1, (cx + reach + size_m / 2.0) / px))
        r0 = int(max(0, (size_m / 2.0 - cy - reach) / px))
        r1 = int(min(n - 1, (size_m / 2.0 - cy + reach) / px))
        for rr in range(r0, r1 + 1):
            py = north[rr]
            for cc in range(c0, c1 + 1):
                ex = east[cc]
                u = (ex - cx) * ct + (py - cy) * st
                v = -(ex - cx) * st + (py - cy) * ct
                d2 = (u / a) ** 2 + (v / b) ** 2
                if d2 >= 1.0:
                    continue
                t = 1.0 - d2                      # 足迹权重：中心 1 → 边缘 0
                # 椭圆 dome 的解析法线（剖面指数 p 决定侧面陡峭程度）
                p = rock["p"]
                tp = max(t, 1e-6)
                dh_du = -2.0 * p * u / (a * a) * tp ** (p - 1)
                dh_dv = -2.0 * p * v / (b * b) * tp ** (p - 1)
                nx, ny, nz = -dh_du, -dh_dv, 1.0
                nl = math.sqrt(nx * nx + ny * ny + nz * nz)
                lambert = max(0.0, (nx * lx + ny * ly + nz * lz) / nl)
                # 岩石基色比周围地表暗（灰色岩），按坡度明暗
                shade = 0.46 + 0.54 * lambert
                out[rr, cc] = out[rr, cc] * (1.0 - t) + out[rr, cc] * shade * t
    return np.clip(out, 0, 255).astype(np.uint8)


def instances_payload(
    instances: Sequence[Dict[str, Any]],
    size_m: float,
    grid: int,
) -> Dict[str, Any]:
    return {
        "size_m": size_m,
        "grid": grid,
        "count": len(instances),
        "rocks": list(instances),
    }
