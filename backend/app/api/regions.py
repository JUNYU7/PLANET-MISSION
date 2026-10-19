"""区域与图层资源接口。

提供区域列表、区域详情、图层清单、高程二进制与图层影像。
"""

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from ..pipeline import registry
from ..settings import LAYER_IDS, SEMANTIC_CLASSES, TI_BAND, TI_COLORS
from ..settings import TI_PASS, TI_SLOW

router = APIRouter(prefix="/api", tags=["regions"])


@router.get("/regions")
def get_regions():
    return {"regions": registry.list_regions()}


@router.get("/regions/{name}")
def get_region(name: str):
    """区域详情：元数据、地形统计、图层清单与渲染档位。

    元数据同时给出绝对海拔与相对起伏两套高程：前者为火星海拔基准，
    后者用于仿真场景，界面需同时展示以免混淆。
    """
    try:
        meta = registry.load_meta(name)
        stats = registry.load_stats(name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))

    return {
        "meta": meta,
        "stats": stats,
        "manifest": {
            "interactive": registry.layer_manifest(name, "interactive"),
            "capture": registry.layer_manifest(name, "capture"),
        },
        "thresholds": {
            "pass": TI_PASS,
            "slow": TI_SLOW,
            "band": TI_BAND,
        },
        "traversability_colors": TI_COLORS,
        "semantic_classes": SEMANTIC_CLASSES,
    }


@router.get("/regions/{name}/assets/{filename}")
def get_asset(name: str, filename: str):
    """按文件名返回区域产物：高程二进制或图层影像。

    走单一路由而非为每个图层开接口，前端只需拼接路径，
    且不必在前端硬编码分辨率相关的文件名。文件不存在时返回 404。
    """
    try:
        path = registry.resolve_layer_path(name, filename)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))

    media = "application/octet-stream" if path.suffix == ".bin" \
        else "image/png"
    # 不传 filename：FileResponse 会据此写入
    # Content-Disposition: attachment，浏览器 fetch 该响应时得到空体。
    # 资源由前端以 fetch/TextureLoader 读取，必须以内联方式返回。
    return FileResponse(
        path,
        media_type=media,
        headers={"Cache-Control": "public, max-age=3600"},
    )

