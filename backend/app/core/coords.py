"""坐标转换：火星投影坐标 ↔ 经纬度 ↔ 栅格行列 ↔ 区域局部坐标。

火星上没有 EPSG:4326 这样的通用地理坐标系，各数据集采用各自独立的
投影定义。本模块用一个 :class:`Projection` 统一承载球面等距圆柱
（Equirectangular / proj=eqc）的三个参数：

    x = R · radians(lon − lon_0)
    y = R · radians(lat) / cos(lat_ts)

其中 R 为火星参考半径、lon_0 为中央经线、lat_ts 为标准纬线。
参数默认值为 (3396190 m, 0°, 0°)，即 ESRI:103885 的定义。
投影参数一律从栅格自身的 CRS 读取（:func:`projection_from_crs`），
不按文件名或区域配置猜测。HiRISE 单景 DTM 的中央经线可达 157.34°、
标准纬线 5°，与 ESRI:103885 相差数千公里；任一常量写死都会让裁剪窗口
偏出影像范围并触发「DTM 窗口越界」。因此换数据源不需要改这里。

非球面（a≠b）与极地立体投影不在支持范围内：前者在本公式下退化为
球面近似（火星数据集实际均为球体），后者需要完全不同的换算。
读取到非 eqc 投影时 :func:`projection_from_crs` 会明确报错而非静默
算错。

本模块同时提供前端球体视图所用的球面坐标换算，供 /api/globe 接口复用，
确保前后端使用同一套公式，避免标记位置错位。
"""

from dataclasses import dataclass
from math import cos, degrees, radians, sin
from typing import Any, Dict, Optional, Tuple

from ..settings import MARS_RADIUS_M

__all__ = [
    "MARS_RADIUS_M",
    "Projection",
    "DEFAULT_PROJECTION",
    "projection_from_crs",
    "lonlat_to_proj",
    "proj_to_lonlat",
    "proj_to_rowcol",
    "proj_to_window",
    "region_offset_m",
    "local_to_lonlat",
    "lonlat_to_sphere",
    "footprint_bbox",
]


@dataclass(frozen=True)
class Projection:
    """球面等距圆柱投影参数。默认即 ESRI:103885。"""

    radius: float = MARS_RADIUS_M
    lon_0: float = 0.0
    lat_ts: float = 0.0

    @property
    def y_scale(self) -> float:
        """y 方向缩放因子：lat_ts=0 时为 1，lat_ts=5° 时约 0.9962。"""
        return cos(radians(self.lat_ts))


#: ESRI:103885（Mars Equirectangular, lat_ts=0, lon_0=0）——
#: 绝大多数火星数据源与历史区域使用的定义。
DEFAULT_PROJECTION = Projection()


def projection_from_crs(crs: Any) -> Projection:
    """从栅格 CRS 提取投影参数。

    使用 ``rasterio.crs.CRS.to_dict()`` 返回的 PROJ 参数表，不解析 WKT
    文本：WKT 在 GDAL 3.x 默认输出 WKT2，参数节点位置随方言变化，而
    ``to_dict()`` 无论输入是 WKT1/WKT2 还是 proj4 串都归一为同一结构
    （例如 ``{'proj': 'eqc', 'lat_ts': 5, 'lon_0': 157.34, 'R': ...}``）。

    ``crs`` 为 None（未标定的裸影像）时返回 ESRI:103885 默认值。
    """
    if crs is None:
        return DEFAULT_PROJECTION

    params: Dict[str, Any] = crs.to_dict()
    proj_name = str(params.get("proj", "")).lower()
    if proj_name != "eqc":
        raise ValueError(
            "仅支持球面等距圆柱投影（proj=eqc），实际为 %r。"
            "极地立体等其它投影需要不同的换算公式，不能沿用本公式。"
            % (proj_name or "未标注")
        )

    # 球体数据集归约为 R；椭球则给 a/b。两者都缺失时退回默认半径。
    # 非球体（a≠b）在球面等距圆柱公式下退化为按赤道半径近似，
    # 火星公开数据集实际均为球体（a=b）。
    radius = params.get("R") or params.get("a") or MARS_RADIUS_M
    radius = float(radius)
    if radius <= 0:
        radius = MARS_RADIUS_M

    lat_0 = float(params.get("lat_0", 0.0) or 0.0)
    if abs(lat_0) > 1e-9:
        raise ValueError(
            "暂不支持 lat_0≠0 的等距圆柱投影（实际 lat_0=%r）。"
            "该类数据请改用极区或自定义投影流程。" % lat_0
        )

    return Projection(
        radius=radius,
        lon_0=float(params.get("lon_0", 0.0) or 0.0),
        lat_ts=float(params.get("lat_ts", 0.0) or 0.0),
    )


def lonlat_to_proj(lon_deg: float, lat_deg: float,
                   proj: Optional[Projection] = None) -> Tuple[float, float]:
    p = proj or DEFAULT_PROJECTION
    x = p.radius * radians(lon_deg - p.lon_0)
    y = p.radius * radians(lat_deg) / p.y_scale
    return x, y


def proj_to_lonlat(x: float, y: float,
                   proj: Optional[Projection] = None) -> Tuple[float, float]:
    p = proj or DEFAULT_PROJECTION
    lon = degrees(x / p.radius) + p.lon_0
    lat = degrees(y * p.y_scale / p.radius)
    return lon, lat


def proj_to_rowcol(transform, x: float, y: float) -> Tuple[int, int]:
    """投影坐标 → 栅格行列号。

    Affine.__mul__ 对二元组的语义是：(col, row) 正变换为 (x, y)」，
    并非反变换，因此这里必须用 rasterio.transform.rowcol，不能写成
    transform * (x, y)，否则会得到完全错误的行列号。

    已实测本机数据（1 m/px DTM 与 0.25 m/px ortho）的 ds.transform 均正确，
    因此不做线性公式回退，以免掩盖数据异常。
    """
    from rasterio.transform import rowcol

    r, c = rowcol(transform, x, y)
    return int(r), int(c)


def proj_to_window(transform, x: float, y: float, width: int, height: int):
    """以投影坐标为中心，生成边长为 width/height 像素的对齐窗口。

    先由投影坐标得行列索引，再向两侧各取一半，使窗口关于中心对称。
    返回 rasterio.windows.Window。窗口必须完全落在栅格范围内，
    越界会导致 rasterio 读入零填充，请在调用前校验。
    """
    from rasterio.windows import Window

    row, col = proj_to_rowcol(transform, x, y)
    return Window(
        col_off=col - width // 2,
        row_off=row - height // 2,
        width=width,
        height=height,
    )


def region_offset_m(
    lon_deg: float,
    lat_deg: float,
    center_lon: float,
    center_lat: float,
    proj: Optional[Projection] = None,
) -> Tuple[float, float]:
    x0, y0 = lonlat_to_proj(center_lon, center_lat, proj)
    x1, y1 = lonlat_to_proj(lon_deg, lat_deg, proj)
    return x1 - x0, y1 - y0


def local_to_lonlat(
    east_m: float,
    north_m: float,
    center_lon: float,
    center_lat: float,
    proj: Optional[Projection] = None,
) -> Tuple[float, float]:
    x0, y0 = lonlat_to_proj(center_lon, center_lat, proj)
    return proj_to_lonlat(x0 + east_m, y0 + north_m, proj)


def lonlat_to_sphere(
    lon_deg: float, lat_deg: float, radius: float
) -> Tuple[float, float, float]:
    """经纬度 → three.js 球面坐标。
        φ = (90 − lat) · π/180
        θ = (lon + 180) · π/180
        x = −R · sin φ · cos θ
        y =  R · cos φ
        z =  R · sin φ · sin θ

    北纬为正、东经为正。约定反了会让标记落到球体背面。
    """
    phi = radians(90.0 - lat_deg)
    theta = radians(lon_deg + 180.0)
    x = -radius * sin(phi) * cos(theta)
    y = radius * cos(phi)
    z = radius * sin(phi) * sin(theta)
    return x, y, z


def footprint_bbox(transform, bounds, crs: Any = None) -> Dict[str, float]:
    """由源栅格的地理范围得到经纬度包围盒。

    返回 {lon_min, lon_max, lat_min, lat_max, width_m, height_m}，
    用于在球体视图上把影像的实际覆盖范围圈出来，而不是用一个抽象圆点表示。

    采用 bounds 而非 transform 直接推算，因为该数据的 transform
    已被验证正确，二者等价，取 bounds 更不易受行列顺序假设影响。
    ``crs`` 决定经纬度与投影坐标的换算关系，必须传入源栅格的真实 CRS——
    HiRISE 单景 DTM 的中央经线不是 0，漏传会让包围盒整体错位数千公里。
    """
    proj = projection_from_crs(crs)
    left, bottom, right, top = bounds
    lon_min, lat_min = proj_to_lonlat(left, bottom, proj)
    lon_max, lat_max = proj_to_lonlat(right, top, proj)
    return {
        "lon_min": lon_min,
        "lon_max": lon_max,
        "lat_min": lat_min,
        "lat_max": lat_max,
        "width_m": right - left,
        "height_m": top - bottom,
    }