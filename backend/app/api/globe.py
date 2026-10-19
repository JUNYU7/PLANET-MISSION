"""火星全球球体接口。

把 Mars.tif 转为前端可直接使用的球体贴图，并提供球面坐标换算，

使前后端共用同一套公式，避免区域标记错位。

Mars.tif 实测经度约定为标准 -180~+180（依据：南纬 20~0 度带内

最暗斑反推 70.2°E，与 Syrtis Major 实际位置吻合）。
"""

import numpy as np
from fastapi import APIRouter
from fastapi.responses import Response

from ..core.coords import lonlat_to_sphere
from ..core.raster_source import resample_to_grid
from ..settings import GLOBE_FILE, GLOBE_SCREEN_DIAMETER_PX

router = APIRouter(prefix="/api/globe", tags=["globe"])

GLOBE_TEX_SIZE = 2048

_CACHE = {}


def _load_rgb():
    """读取并缓存全球影像的 RGB uint8 数组。"""
    if "rgb" not in _CACHE:
        if not GLOBE_FILE.exists():
            raise FileNotFoundError(
                "未找到全球影像 %s，球体视图不可用" % GLOBE_FILE)
        import rasterio
        from PIL import Image
        import io as _io

        with rasterio.open(GLOBE_FILE) as ds:
            count = ds.count
            if count >= 3:
                arr = ds.read([1, 2, 3])
            else:
                arr = ds.read([1, 1, 1])
        data = np.transpose(arr, (1, 2, 0)).astype(np.uint8)
        buf = _io.BytesIO()
        Image.fromarray(data, mode="RGB").save(buf, format="PNG", optimize=True)
        _CACHE["png"] = buf.getvalue()
        _CACHE["shape"] = data.shape
    return _CACHE


@router.get("/texture")
def get_globe_texture():
    cache = _load_rgb()
    return Response(content=cache["png"], media_type="image/png",
                    headers={"Cache-Control": "public, max-age=86400"})


@router.get("/meta")
def get_globe_meta():
    """球体视图参数：贴图尺寸、推荐屏幕直径、坐标约定。"""
    cache = _load_rgb()
    height, width = cache["shape"][0], cache["shape"][1]
    return {
        "texture_width": width,
        "texture_height": height,
        "screen_diameter_px": GLOBE_SCREEN_DIAMETER_PX,
        "lon_convention": "-180_180",
        "note": (
            "贴图为 %dx%d，每像素约 %.2f 公里。球体在屏幕上直径控制在"
            "%d 像素左右时清晰度已足够，再放大会显模糊。"
            % (width, height, width / 720.0 * 25.4,
               GLOBE_SCREEN_DIAMETER_PX)
        ),
    }


@router.get("/project")
def project_point(lon: float, lat: float, radius: float = 3.396):
    """经纬度 → three.js 球面坐标。

    与后端 core.coords 使用同一实现，前端可直接调用本接口取得标记位置，
    无需在前端重复实现公式。radius 缺省为火星半径按 1:1e6 缩放后的值。
    """
    x, y, z = lonlat_to_sphere(lon, lat, radius)
    return {"x": x, "y": y, "z": z, "radius": radius}

