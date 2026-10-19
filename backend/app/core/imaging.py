"""影像输出：图层着色与 PNG 写出。

数据类图层（坡度、曲率、粗糙度、可通行性、语义）以固定配色渲染为

PNG，供前端叠加显示。前端以 NoColorSpace 加载，避免伽马变换影响

数值解读。
"""

import numpy as np
from PIL import Image

from ..settings import SEMANTIC_CLASSES, TI_COLORS
from .traversability import (
    TI_CLASS_BAND,
    TI_CLASS_FORBIDDEN,
    TI_CLASS_PASS,
    TI_CLASS_SLOW,
)

__all__ = ["save_gray_png", "save_slope_png", "save_curvature_png",
           "save_traversability_png", "save_semantic_png",
           "colorize", "CLASS_COLORS"]

CLASS_COLORS = [
    (141, 123, 107),
    (201, 162, 39),
    (141, 123, 107),
    (92, 74, 61),
    (52, 199, 89),
]


def _hex_to_rgb(value: str):
    value = value.lstrip("#")
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def colorize(index_array, palette):
    lut = np.zeros((256, 3), dtype=np.uint8)
    for i, color in enumerate(palette):
        lut[i] = color
    return lut[np.clip(index_array, 0, 255).astype(np.uint8)]


def save_rgb(path, rgb):
    Image.fromarray(np.ascontiguousarray(rgb), mode="RGB").save(path,
                                                                 optimize=True)


def save_gray(path, gray):
    Image.fromarray(np.ascontiguousarray(gray), mode="L").save(path,
                                                                optimize=True)


def save_gray_png(path, gray):
    save_gray(path, gray)


def save_slope_png(path, slope, scale_max: float = 30.0):
    """坡度分层着色：0–5 度绿、5–15 黄、15–30 橙、30 以上红。"""
    stops = [(5.0, (34, 197, 89)), (15.0, (255, 214, 10)),
             (30.0, (255, 140, 66)), (1e9, (255, 59, 48))]
    rgb = np.zeros(slope.shape + (3,), dtype=np.uint8)
    prev = 0.0
    for limit, color in stops:
        mask = (slope > prev) & (slope <= limit)
        for ch in range(3):
            rgb[..., ch][mask] = color[ch]
        prev = limit
    save_rgb(path, rgb)


def save_curvature_png(path, curv, scale: float = 0.05):
    """曲率双色发散着色：凸起偏红、凹坑偏蓝、接近零为中性灰。"""
    norm = np.clip(curv / scale, -1.0, 1.0)
    rgb = np.zeros(curv.shape + (3,), dtype=np.uint8)
    pos = norm > 0
    neg = norm < 0
    mid = ~(pos | neg)
    rgb[..., 0][pos] = (200 * norm[pos]).astype(np.uint8)
    rgb[..., 2][neg] = (200 * -norm[neg]).astype(np.uint8)
    for ch in range(3):
        rgb[..., ch][mid] = 110
    save_rgb(path, rgb)


def save_traversability_png(path, classes):
    """可通行性四值着色：绿可通行、黄缓行、红禁行、灰不确定带。"""
    palette = [
        _hex_to_rgb(TI_COLORS["band"]),
        _hex_to_rgb(TI_COLORS["pass"]),
        _hex_to_rgb(TI_COLORS["slow"]),
        _hex_to_rgb(TI_COLORS["forbidden"]),
    ]
    save_rgb(path, colorize(classes, palette))


def save_semantic_png(path, sem):
    """语义四值着色，索引 0 为未分类。"""
    palette = [
        _hex_to_rgb("#3A3128"),
        _hex_to_rgb(SEMANTIC_CLASSES["sand"]["color"]),
        _hex_to_rgb(SEMANTIC_CLASSES["bedrock"]["color"]),
        _hex_to_rgb(SEMANTIC_CLASSES["boulder"]["color"]),
        _hex_to_rgb(SEMANTIC_CLASSES["base"]["color"]),
    ]
    save_rgb(path, colorize(sem, palette))

