"""地形查询层（策划书第 21 章）：坐标 → 地形属性。

任务规划、路径规划、环境观测共用同一查询实现，保证前端、训练
环境、Gazebo 三处对地形的理解完全一致。

数据来源（数据处理阶段落盘）：
- height_<grid>.bin    相对高程 float32
- classes_<grid>.u8    TI 四分类（0 不确定 / 1 可通行 / 2 缓行 / 3 禁行）
- sem_<grid>.u8        语义四分类（0 未分类 / 1 沙地 / 2 裸岩 / 3 巨石 / 4 基站）

坐标约定与前端三维场景、Gazebo 导出一致：
x 向东为正、y 向南为正（即前端场景的 z 轴）、z 为相对高程（向上）。
原点为区域裁剪中心。
"""

from __future__ import annotations

import json
from typing import Any, Dict

import numpy as np

from ..settings import SEMANTIC_ORDER, region_dir

__all__ = ["query_at", "TI_NAMES", "SEM_NAMES"]

# 类别数值 → 名称（与 core.traversability / core.semantic 的编码一致）
TI_NAMES = {0: "band", 1: "pass", 2: "slow", 3: "forbidden"}
SEM_NAMES = {0: "unknown"}
for _i, _name in enumerate(SEMANTIC_ORDER, start=1):
    SEM_NAMES[_i] = _name

_CACHE: Dict[str, Dict[str, Any]] = {}


def _load_region(name: str) -> Dict[str, Any]:
    """读取并缓存区域查询栅格。栅格为数 MB 级，进程内缓存即可。"""
    if name in _CACHE:
        return _CACHE[name]

    meta_path = region_dir(name) / "region_meta.json"
    with open(meta_path, "r", encoding="utf-8") as fh:
        meta = json.load(fh)
    grid = int(meta["grids"]["interactive"])

    def _read_bin(suffix: str, dtype) -> np.ndarray:
        path = region_dir(name) / (suffix % grid)
        raw = path.read_bytes()
        return np.frombuffer(raw, dtype=dtype).reshape(grid, grid)

    height = _read_bin("height_%d.bin", np.float32).astype(np.float64)
    classes = _read_bin("classes_%d.u8", np.uint8)
    sem = _read_bin("sem_%d.u8", np.uint8)

    size_m = float(meta["size_m"])
    entry = {
        "height": height,
        "classes": classes,
        "sem": sem,
        "size_m": size_m,
        "n": grid,
        # 像元尺寸（米）
        "px": size_m / (grid - 1),
    }
    _CACHE[name] = entry
    return entry


def _bilinear(arr: np.ndarray, n: int, fx: float, fy: float) -> float:
    x0, y0 = int(np.floor(fx)), int(np.floor(fy))
    x1, y1 = min(x0 + 1, n - 1), min(y0 + 1, n - 1)
    tx, ty = fx - x0, fy - y0
    h00, h10 = arr[y0, x0], arr[y0, x1]
    h01, h11 = arr[y1, x0], arr[y1, x1]
    return (h00 * (1 - tx) + h10 * tx) * (1 - ty) + \
        (h01 * (1 - tx) + h11 * tx) * ty


def query_at(name: str, x: float, y: float) -> Dict[str, Any]:
    """查询世界坐标 (x 东, y 南) 处的地形属性。

    高程双线性采样；类别最近邻（类别栅格禁止插值）；坡度由邻近
    高程的中心差分推算；粗糙度取 3×3 邻域高程标准差。越界坐标
    被裁剪到区域边缘（与渲染一致）。
    """
    d = _load_region(name)
    n = d["n"]
    half = d["size_m"] / 2.0
    fx = float(np.clip((x + half) / d["px"], 0, n - 1))
    fy = float(np.clip((y + half) / d["px"], 0, n - 1))

    z = _bilinear(d["height"], n, fx, fy)

    # 类别最近邻
    ci, cj = int(round(fx)), int(round(fy))
    ci, cj = min(ci, n - 1), min(cj, n - 1)
    ti_class = int(d["classes"][cj, ci])
    sem_idx = int(d["sem"][cj, ci])

    # 坡度：中心差分（米/米），对周围 2 px 内做钳位
    x0, x1 = max(ci - 1, 0), min(ci + 1, n - 1)
    y0, y1 = max(cj - 1, 0), min(cj + 1, n - 1)
    dh_dEast = (float(d["height"][cj, x1]) - float(d["height"][cj, x0])) \
        / max(x1 - x0, 1) / d["px"]
    dh_dSouth = (float(d["height"][y1, ci]) - float(d["height"][y0, ci])) \
        / max(y1 - y0, 1) / d["px"]
    slope_deg = float(np.degrees(np.arctan(np.hypot(dh_dEast, dh_dSouth))))

    # 粗糙度：3×3 邻域高程标准差
    r0, r1 = max(cj - 1, 0), min(cj + 2, n)
    c0, c1 = max(ci - 1, 0), min(ci + 2, n)
    window = d["height"][r0:r1, c0:c1]
    roughness_m = float(window.std())

    return {
        "z": round(z, 3),
        "ti_class": ti_class,
        "ti_name": TI_NAMES[ti_class],
        "slope_deg": round(slope_deg, 2),
        "semantic": SEM_NAMES[sem_idx],
        "roughness_m": round(roughness_m, 4),
    }
