"""栅格读取：窗口裁剪、重采样、缺失填充、正射影像灰度拉伸。

本模块封装对大体积源数据（1.75 GB DTM / 7 GB ortho / HiRISE 单景
352 MB DTM + 384 MB JP2 ortho）的安全访问。所有读取均通过窗口进行，
严禁将整幅影像载入内存。

投影参数不按文件名猜测，一律从栅格自身的 ``ds.crs`` 读取
（见 :func:`app.core.coords.projection_from_crs`）：HiRISE 单景 DTM
使用中央经线非 0 的局部等距圆柱投影，写死 lon_0=0 会算偏数千公里。
"""

import numpy as np
import rasterio
from scipy import ndimage

from ..settings import (
    ORTHO_NODATA_VALUE,
    ORTHO_STRETCH_HI,
    ORTHO_STRETCH_LO,
    SMOOTH_SIGMA_M,
)
from . import coords

__all__ = [
    "read_dtm_window",
    "read_ortho_window",
    "fill_invalid",
    "to_relative",
    "resample_to_grid",
    "resample_nearest",
    "grid_offsets",
    "percentile_stretch",
    "smooth_field",
]


def read_dtm_window(path, lon: float, lat: float, size_m: float):
    """读取以经纬度为中心、边长 size_m 的 DTM 子区。

    返回 ``(高程数组, 边长像素, 像元边长米)``。

    像元大小取自栅格自身的 ``transform.a`` 而非调用方传入的标称值：
    HiRISE DTM 实测为 1.0113 m/px（页面标注 1.01），若按标称 1.0
    换算窗口边长，2000 m 的场景会实际取到 2022.6 m，后续
    slope/roughness/TI 的量纲全部带 1.1% 系统偏差。

    越界时抛出 ValueError，避免 rasterio 以零填充静默返回破洞数据。
    """
    with rasterio.open(path) as ds:
        proj = coords.projection_from_crs(ds.crs)
        pixel_m = abs(ds.transform.a)
        width = int(round(size_m / pixel_m))
        x, y = coords.lonlat_to_proj(lon, lat, proj)
        win = coords.proj_to_window(ds.transform, x, y, width, width)
        if (win.row_off < 0 or win.col_off < 0
                or win.row_off + win.height > ds.height
                or win.col_off + win.width > ds.width):
            raise ValueError(
                "DTM 窗口越界：rows %d~%d cols %d~%d，影像 %dx%d"
                % (win.row_off, win.row_off + win.height,
                   win.col_off, win.col_off + win.width, ds.height, ds.width)
            )
        arr = np.asarray(ds.read(1, window=win), dtype=np.float64)
        nodata = ds.nodata

    if nodata is not None:
        arr = np.where(arr == nodata, np.nan, arr)
    return arr, width, pixel_m


def read_ortho_window(path, lon: float, lat: float, size_m: float):
    """读取以经纬度为中心的正射影像子区，返回 (灰度数组, 有效掩膜)。

    窗口像素数由数据集自身的像元尺寸推算：DTM 为 1.0113 m/px、
    正射为 0.25 m/px，两者相差约 4 倍，若沿用 DTM 的分辨率参数，
    正射影像覆盖范围会缩小到四分之一。

    有效掩膜优先使用栅格自带的 nodata；JP2 等格式不携带 nodata 时
    回退到 ORTHO_NODATA_VALUE。实测 HiRISE ortho 的中心 8x8 km
    区域零值率为 0，故回退值对本批数据成立。
    """
    with rasterio.open(path) as ds:
        proj = coords.projection_from_crs(ds.crs)
        pixel_m = abs(ds.transform.a)
        width = int(round(size_m / pixel_m))
        x, y = coords.lonlat_to_proj(lon, lat, proj)
        win = coords.proj_to_window(ds.transform, x, y, width, width)
        if (win.row_off < 0 or win.col_off < 0
                or win.row_off + win.height > ds.height
                or win.col_off + win.width > ds.width):
            raise ValueError(
                "ortho 窗口越界：rows %d~%d cols %d~%d，影像 %dx%d"
                % (win.row_off, win.row_off + win.height,
                   win.col_off, win.col_off + win.width, ds.height, ds.width)
            )
        arr = np.asarray(ds.read(1, window=win), dtype=np.float64)
        nodata = ds.nodata

    invalid = ORTHO_NODATA_VALUE if nodata is None else nodata
    return arr, arr != invalid


def fill_invalid(arr):
    """用最近有效像素填充 NaN，返回 (填充后数组, 填充前缺失比例)。

    采用 scipy.ndimage.distance_transform_edt 的反向索引：对缺失掩膜求到最近
    有效像素的距离，同时取回该像素的位置索引并按该索引取值。相比迭代扩散，
    一次性完成，且不会在大片缺失区产生方向性拖影。
    """
    missing = ~np.isfinite(arr)
    ratio = float(missing.mean())
    if ratio <= 0.0:
        return arr.copy(), 0.0
    if ratio >= 1.0:
        raise ValueError("整幅窗口均为缺失数据，无法填充")

    indices = ndimage.distance_transform_edt(
        missing, return_distances=False, return_indices=True
    )
    filled = arr[tuple(indices)]
    return filled, ratio


def to_relative(arr):
    """转为相对高程：减去区域最小值，使最小值为 0。

    源 DTM 采用 MOLA topography / DeltaGeoid 基准，绝对海拔约 −2500 m。
    仿真场景必须使用相对高程，否则整个场景位于 z ≈ −2500，后续物理仿真
    会异常。绝对海拔在 region_meta.json 中另行记录，界面同时展示两套数值。
    """
    base = float(np.nanmin(arr))
    return arr - base, base


def resample_to_grid(arr, out_n: int):
    """把方形数组重采样到 out_n × out_n，双线性插值。

    降采样时先做低通滤波再插值，防止空间混叠（aliasing）。实测该区域的
    沙脊纹理波长约 10–20 m，若直接以order=1 从 1 m/px 降到 1.95 m/px，
    高频细节会被混叠成虚假起伏，或被完全抹平，导致坡度与粗糙度失真。
    低通标准差取 (k−1)/2，k 为缩放倍数，这是栅格重采样的常规做法。
    使用双线性而非双三次：立方卷积在平滑地形上会引入可见波纹。
    
    """
    h, w = arr.shape
    if h != w:
        raise ValueError("输入必须为方形数组，实际 %dx%d" % (w, h))
    if h == out_n:
        return arr.astype(np.float64, copy=True)

    factor = float(out_n) / float(h)
    work = arr
    if out_n < h:
        k = h / float(out_n)
        work = ndimage.gaussian_filter(arr, sigma=(k - 1.0) / 2.0,
                                       mode="nearest")
    zoom = (factor, factor)
    return ndimage.zoom(work, zoom, order=1, mode="nearest", prefilter=False,
                        grid_mode=True)


def resample_nearest(arr, out_n: int):
    """最近邻重采样，用于类别栅格。

    类别图不可用双线性：插值会把不同类别的取值混合，产生不存在的类别值。
    这里直接用整数索引映射，不做任何数值插值，因此输出 dtype 与输入一致，
    也不会引入浮点残值。降采样时未做面积加权，属类别栅格的常规取舍：
    阈值判定已在源分辨率完成，此处仅用于渲染。
    """
    h, w = arr.shape
    if h != w:
        raise ValueError("输入必须为方形数组，实际 %dx%d" % (w, h))
    if h == out_n:
        return arr.copy()

    ratio = float(h) / float(out_n)
    idx = np.rint((np.arange(out_n) + 0.5) * ratio - 0.5).astype(int)
    idx = np.clip(idx, 0, h - 1)
    return arr[np.ix_(idx, idx)]


def grid_offsets(h: int):
    """返回每个像素对应的米级坐标偏移 (东向数组, 北向数组)。

    源栅格 row0 在北侧，故北向偏移随行号递减。像素尺寸按 1 m 计。
    用于把像素索引换算成物理坐标，供坡度等指标的量纲换算使用。
    """
    size = float(h)
    cols = np.arange(h, dtype=np.float64)
    rows = np.arange(h, dtype=np.float64)
    east = (cols + 0.5) / size - 0.5
    north = 0.5 - (rows + 0.5) / size
    return east, north


def percentile_stretch(arr, valid=None, lo: float = ORTHO_STRETCH_LO,
                       hi: float = ORTHO_STRETCH_HI):
    """按分位数裁剪做对比度拉伸，输出 uint8 灰度图。

    使用 lo–hi 分位数而非 min/max：正射影像含极暗阴影区与零值，
    min/max 拉伸会把主体压到很窄的灰度区间。
    """
    data = arr if valid is None else arr[valid]
    data = data[np.isfinite(data)]
    if data.size == 0:
        return np.zeros(arr.shape, dtype=np.uint8)

    v_lo = float(np.percentile(data, lo))
    v_hi = float(np.percentile(data, hi))
    if v_hi <= v_lo:
        v_lo = float(data.min())
        v_hi = float(data.max())
    if v_hi <= v_lo:
        return np.zeros(arr.shape, dtype=np.uint8)

    out = (np.clip(arr, v_lo, v_hi) - v_lo) / (v_hi - v_lo)
    return (out * 255.0).astype(np.uint8)


def smooth_field(arr, pixel_size_m: float = 1.0,
                 sigma_m: float = SMOOTH_SIGMA_M):
    """高斯平滑，抑制 DTM 垂直噪声。

    1 m/px DTM 的垂直噪声可达数十厘米，直接求梯度会得到满屏噪点，
    进而使坡度与可通行性判定失效（V4 16.3）。因此算坡度前必须平滑。
    sigma 以米给出，除以像元尺寸转换为像素。
    """
    if sigma_m <= 0:
        return arr.copy()
    return ndimage.gaussian_filter(
        arr, sigma=sigma_m / float(pixel_size_m), mode="nearest"
    )
