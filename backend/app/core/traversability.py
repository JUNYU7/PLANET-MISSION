"""可通行性指数（TI）与三阈值判定。

依据 V4 策划书第 17 章。TI 由坡度、粗糙度、语义可通行分与曲率

四项因子加权合成，归一化后取值于 [0, 1]。

阈值判定额外输出「不确定带」：量化台阶与数据噪声会使阈值附近的

判定本身不可靠，该带单独着色并从可通行面积统计中剔除，避免

噪声被算法误读为障碍，或被算法刷分（V4 17.2）。
"""

import numpy as np

from ..settings import (
    CURV_SCALE,
    ROUGH_SCALE_M,
    SLOPE_SCALE_DEG,
    TI_BAND,
    TI_PASS,
    TI_SLOW,
    TI_W_CURV,
    TI_W_ROUGH,
    TI_W_SEMANTIC,
    TI_W_SLOPE,
)

__all__ = ["traversability_index", "classify", "class_ratios",
           "TI_CLASS_PASS", "TI_CLASS_SLOW", "TI_CLASS_FORBIDDEN",
           "TI_CLASS_BAND"]

TI_CLASS_PASS = 1
TI_CLASS_SLOW = 2
TI_CLASS_FORBIDDEN = 3
TI_CLASS_BAND = 0


def traversability_index(slope, rough, semantic_score, curv):
    """合成可通行性指数 TI，取值 [0, 1]。

    TI = w1*(1-θ̃) + w2*(1-R̄) + w3*S_sem + w4*(1-|C̄|)

    其中 θ̃ 为归一化坡度、R̄ 为归一化粗糙度、C̄ 为归一化曲率绝对值，
    S_sem 为语义可通行分。各因子在归一化后均落在 [0, 1]。
    """
    if not (slope.shape == rough.shape == semantic_score.shape == curv.shape):
        raise ValueError("各因子形状必须一致")

    theta = np.clip(slope / SLOPE_SCALE_DEG, 0.0, 1.0)
    r_bar = np.clip(rough / ROUGH_SCALE_M, 0.0, 1.0)
    c_bar = np.clip(np.abs(curv) / CURV_SCALE, 0.0, 1.0)
    s_sem = np.clip(semantic_score, 0.0, 1.0)

    ti = (TI_W_SLOPE * (1.0 - theta)
          + TI_W_ROUGH * (1.0 - r_bar)
          + TI_W_SEMANTIC * s_sem
          + TI_W_CURV * (1.0 - c_bar))
    return np.clip(ti, 0.0, 1.0)


def classify(ti):
    """按三阈值将 TI 划分为四类，返回 (类别数组, 是否为不确定带)。

    类别取值：TI_CLASS_BAND=0不确定、TI_CLASS_PASS=1 可通行、
    TI_CLASS_SLOW=2 缓行、TI_CLASS_FORBIDDEN=3 禁行。

    不确定带的判定优先于三个阈值：只要 TI 落在任一阈值的 ±TI_BAND 邻域内，
    即判为不确定带，避免量化误差被当作确定的通行或禁行结论。
    """
    near_pass = np.abs(ti - TI_PASS) < TI_BAND
    near_slow = np.abs(ti - TI_SLOW) < TI_BAND

    classes = np.full(ti.shape, TI_CLASS_BAND, dtype=np.uint8)
    definite = ~(near_pass | near_slow)
    classes[definite & (ti >= TI_PASS)] = TI_CLASS_PASS
    classes[definite & (ti < TI_PASS) & (ti >= TI_SLOW)] = TI_CLASS_SLOW
    classes[definite & (ti < TI_SLOW)] = TI_CLASS_FORBIDDEN
    return classes, near_pass | near_slow


def class_ratios(classes):
    """统计四类面积占比，返回 (pass_ratio, slow_ratio, forbid_ratio, band_ratio)。

    各类占比之和为 1。不确定带不计入可通行面积（V4 17.2）。
    """
    total = float(classes.size)
    band = float((classes == TI_CLASS_BAND).sum()) / total
    ok = float((classes == TI_CLASS_PASS).sum()) / total
    slow = float((classes == TI_CLASS_SLOW).sum()) / total
    forbid = float((classes == TI_CLASS_FORBIDDEN).sum()) / total
    return ok, slow, forbid, band

