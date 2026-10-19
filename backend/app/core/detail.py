"""地表细节增强：分形微起伏、细节法线、粗糙度图与正射锐化。

源 DTM 经平滑与重采样低通后，表面只剩波长几十米的沙脊，目观
"过于光滑"。本模块分两路补细节，互不混淆：

- **高程路（进度量）**：``fbm_relief`` 在指标计算前向高度场注入
  分形微起伏。用结构化多octave 噪声而非白噪声——白噪声会让
  坡度/粗糙度指标被单像素抖动支配（raster_source 的平滑注释
  说的就是它），而 4–8 m 波长的起伏是真实的风蚀纹理尺度，
  坡度、粗糙度、曲率、TI、法线、晕渲全部随之合理地变糙。
  波长下限取 4 m（源 1 m/px 的 4 px），从根上避免混叠。

- **纹理路（纯视觉）**：``detail_normal`` 向法线贴图叠加程序化
  高频细节；``roughness_texture`` 生成空间变化的粗糙度图；
  ``unsharp`` 对正射灰度做高通增强。三者不碰任何度量。

坐标约定同 raster_source：数组 row0 在北、col0 在西；切空间
法线约定同 process_region._normal_map_from_height（R→东、
G→北、128 为无倾斜）。
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Sequence, Tuple

import numpy as np
from scipy import ndimage

__all__ = [
    "DETAIL_DEFAULTS",
    "fbm_relief",
    "detail_normal",
    "roughness_texture",
    "unsharp",
]

DETAIL_DEFAULTS: Dict[str, Any] = {
    "fbm_enabled": False,
    "fbm_seed": 77123,
    "fbm_octaves_m": [[8.0, 0.10], [4.0, 0.04]],
    # 法线细节：波长 ≥4 m（两档纹理均高于 Nyquist，观感一致）；
    # 强度由等效 RMS 坡度（度）决定，与波长/幅度解耦
    "normal_detail_slope_deg": 8.0,
    "normal_octaves_m": [[8.0, 1.0], [4.0, 0.5]],
    "roughness_base": 0.92,
    "roughness_variation": 0.14,
    "roughness_octaves_m": [[6.0, 1.0], [3.0, 0.5]],
    "unsharp_amount": 0.55,
    "unsharp_sigma_px": 1.2,
}


def _merged(cfg: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(DETAIL_DEFAULTS)
    out.update({k: v for k, v in (cfg or {}).items() if v is not None})
    return out


def _octave_field(
    rng: np.random.Generator,
    n: int,
    size_m: float,
    wavelength_m: float,
) -> np.ndarray:
    """生成一个 octave 的标准化（零均值单位方差）无缝噪声场。

    先按波长决定噪声栅格数，再双线性放大到 n×n。grid-wrap 使
    放大在边缘环绕，避免场景四边出现拉伸痕迹。
    波长小于 2 个像元时返回 None（调用方跳过）——那已低于
     Nyquist，放大只会产出混叠噪点。
    """
    cells = int(round(size_m / max(wavelength_m, 1e-6)))
    if cells < 2 or cells >= n:
        return None
    noise = rng.standard_normal((cells, cells))
    zoom = float(n) / float(cells)
    field = ndimage.zoom(noise, zoom, order=1, mode="grid-wrap",
                         grid_mode=True)
    if field.shape[0] != n:  # zoom 取整误差的兜底
        field = field[:n, :n]
    std = float(field.std())
    if std < 1e-9:
        return None
    return field / std


def fbm_relief(
    height: np.ndarray,
    cfg: Dict[str, Any],
    pixel_m: float,
    seed: int,
) -> np.ndarray:
    """向高度场注入分形微起伏，返回新数组（不改原图）。

    每个 octave 的幅度即高程标准差（米）。structured noise：
    相邻 octave 用同一 rng 顺序采样，整体可复现。
    """
    c = _merged(cfg)
    n = height.shape[0]
    size_m = n * pixel_m
    rng = np.random.default_rng(int(seed))
    out = height.astype(np.float64, copy=True)
    for wl, amp in c["fbm_octaves_m"]:
        field = _octave_field(rng, n, size_m, float(wl))
        if field is None:
            continue
        out += field * float(amp)
    return out


def detail_normal(
    normal_rgb: np.ndarray,
    cfg: Dict[str, Any],
    size_m: float,
    seed: int,
) -> np.ndarray:
    """把程序化高频细节叠加进切空间法线贴图（UDN 式混合）。

    normal_rgb: uint8 (n, n, 3)，约定同 _normal_map_from_height。

    三步处理保证「两档纹理观感一致且不混叠」：

    1. **波长下限**：噪声 octave 波长 ≥ ~2.5 m（默认 8/4 m）。
       高清档 4096 纹理 0.49 m/px 下 3 px 即 ≥1.5 m，更细的 octave
       在标准档被 mipmap 平滑、在高清档显形为盐椒静态噪声；
    2. **场平滑**：双线性放大的随机场在细胞边界不连续，梯度尖峰
       是静态感的主要来源，先做 1 px 高斯平滑；
    3. **RMS 归一**：梯度归一到目标 RMS 坡度（切线单位），细节
       强度与波长、幅度解耦，调一个「等效坡度」参数即可预测。
    """
    c = _merged(cfg)
    n = normal_rgb.shape[0]
    slope_deg = float(c.get("normal_detail_slope_deg", 8.0))
    if slope_deg <= 0.0 or not c.get("normal_octaves_m"):
        # 显式关闭：直接返回基法线（用户反馈程序化细节噪声感重，
        # 默认关闭；需要时把 normal_detail_slope_deg 调到 4–10 再启用）
        return normal_rgb
    rng = np.random.default_rng(int(seed) + 1)
    det = np.zeros((n, n), dtype=np.float64)
    for wl, amp in c["normal_octaves_m"]:
        field = _octave_field(rng, n, size_m, float(wl))
        if field is None:
            continue
        det += field * float(amp)
    # 细胞边界平滑：消除梯度尖峰（静态噪声观感的主要来源）
    det = ndimage.gaussian_filter(det, sigma=1.0, mode="nearest")
    gy, gx = np.gradient(det)
    # 与 _normal_map_from_height 同约定：R(东)=-d/dcol，G(北)=+d/drow
    target = math.tan(math.radians(slope_deg))
    rms = math.sqrt(float((gx * gx + gy * gy).mean()))
    if rms > 1e-9:
        k = target / rms
        gx = gx * k
        gy = gy * k
    base = normal_rgb.astype(np.float64) / 255.0 * 2.0 - 1.0
    cx = base[..., 0] - gx
    cy = base[..., 1] + gy
    cz = base[..., 2]
    norm = np.sqrt(cx * cx + cy * cy + cz * cz)
    norm = np.maximum(norm, 1e-9)
    rgb = np.stack([cx / norm, cy / norm, cz / norm], axis=-1)
    return np.clip((rgb * 0.5 + 0.5) * 255.0, 0, 255).astype(np.uint8)


def roughness_texture(
    tex_n: int,
    size_m: float,
    slope_tex: np.ndarray,
    cfg: Dict[str, Any],
    seed: int,
) -> np.ndarray:
    """生成粗糙度灰度图（uint8，0–255 ↔ roughness 0–1）。

    基础值 ± 噪声变化，并随坡度上浮（陡处砾石富集，更粗糙）。
    slope_tex 为同分辨率的坡度场（度）。
    """
    c = _merged(cfg)
    rng = np.random.default_rng(int(seed) + 2)
    noise = np.zeros((tex_n, tex_n), dtype=np.float64)
    got = 0
    for wl, amp in c["roughness_octaves_m"]:
        field = _octave_field(rng, tex_n, size_m, float(wl))
        if field is None:
            continue
        noise += field * float(amp)
        got += 1
    if got > 0:
        noise /= got
    base = float(c["roughness_base"])
    var = float(c["roughness_variation"])
    r = base + var * np.clip(noise, -1.5, 1.5) * 0.5
    # 坡度上浮：0–20° 线性加 0–0.08
    r = r + 0.08 * np.clip(slope_tex, 0.0, 20.0) / 20.0
    return np.clip(r * 255.0, 0, 255).astype(np.uint8)


def unsharp(
    gray: np.ndarray,
    amount: float,
    sigma_px: float,
) -> np.ndarray:
    """正射灰度高通增强（unsharp mask），恢复重采样低通削掉的反差。

    在目标纹理分辨率上调用（数组不太大）；amount 为增强量，
    sigma_px 为模糊半径（纹理像元）。
    """
    if amount <= 0:
        return gray
    blur = ndimage.gaussian_filter(gray.astype(np.float64),
                                   sigma=float(sigma_px), mode="nearest")
    out = gray.astype(np.float64) + float(amount) * (
        gray.astype(np.float64) - blur)
    return np.clip(out, 0, 255).astype(np.uint8)
