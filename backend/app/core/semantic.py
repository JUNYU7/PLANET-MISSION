"""语义地形分类：沙地 / 裸岩 / 巨石 / 基站。

以坡度、粗糙度与高程突变为判据做规则分类。

输出栅格分类图与通行分、摩擦系数表；岩石的三维实例化

"""

import numpy as np
from scipy import ndimage

from ..settings import (
    ROUGH_WINDOW,
    SEMANTIC_CLASSES,
    SEMANTIC_ORDER,
)
from .terrain_metrics import roughness

__all__ = ["classify_semantic", "semantic_scores", "semantic_friction"]

SEM_NONE = 0
SEM_SAND = 1
SEM_BEDROCK = 2
SEM_BOULDER = 3
SEM_BASE = 4

# 巨石判据：高程突变与曲率同时超阈值
BOULDER_RELIEF_M = 0.6
BOULDER_CURV = 0.05

# 连通域面积上限（像素，源分辨率 1 m/px）。用于区分孤立岩块与延伸性地形：
# 巨石是局部孤立的凸起，连通域面积小；沙脊、风蚀脊连续延伸达数十万平方米。
# 取 150 像素约合 12 m × 12 m，略大于典型岩块（0.3–3 m），
# 使真实岩块可被识别，同时排除条带状沙脊。
BOULDER_MAX_AREA_PX = 150

# 沙地判据：低坡度且低粗糙度
SAND_SLOPE_DEG = 8.0
SAND_ROUGH_M = 0.35


def classify_semantic(height, slope, curv, base_mask=None):
    """规则语义分类，返回 uint8 类别数组。

    判据顺序有讲究：巨石优先级最高（避免被误判为裸岩），
    沙地要求同时低坡度与低粗糙度，其余归为裸岩。
    base_mask 非空时以 True 处标记基站，用于着陆点周边。

    巨石判据除高程突变与曲率外，还需通过连通域面积约束。仅凭局部凸起
    会把沙脊、风蚀脊这类延伸性地形整体判为巨石——实测该区域沙脊面积
    连续达数十万平方米，会被误判成「不可通行」，而实际上 rover 在沙脊
    附近的真实困难来自坡度与侧翻风险，应由 TI 的坡度因子表达，
    而不是把整条沙脊标成岩块。加入连通域面积上限后，沙脊归为裸岩，
    只有孤立小面积凸起才判为巨石。
    """
    rough = roughness(height, ROUGH_WINDOW)

    relief = ndimage.maximum_filter(height, size=5) - \
        ndimage.minimum_filter(height, size=5)

    out = np.full(height.shape, SEM_BEDROCK, dtype=np.uint8)

    sand = (slope < SAND_SLOPE_DEG) & (rough < SAND_ROUGH_M)
    out[sand] = SEM_SAND

    candidate = (relief > BOULDER_RELIEF_M) & (np.abs(curv) > BOULDER_CURV)
    labels, count = ndimage.label(candidate)
    if count > 0:
        sizes = np.bincount(labels.ravel())
        small = sizes <= BOULDER_MAX_AREA_PX
        small[0] = False
        out[small[labels]] = SEM_BOULDER

    if base_mask is not None:
        out[np.asarray(base_mask, dtype=bool)] = SEM_BASE

    return out


def semantic_scores(sem):
    """类别栅格 → 语义可通行分数组（float，取值 [0, 1]）。"""
    table = np.zeros(5, dtype=np.float64)
    for idx, key in enumerate(SEMANTIC_ORDER):
        table[idx + 1] = float(SEMANTIC_CLASSES[key]["score"])
    return table[sem]


def semantic_friction(sem):
    table = np.zeros(5, dtype=np.float64)
    for idx, key in enumerate(SEMANTIC_ORDER):
        table[idx + 1] = float(SEMANTIC_CLASSES[key]["friction"])
    return table[sem]

