"""Gazebo / ROS2 导出接口。

触发某个区域的 Gazebo 仿真包导出，或查询已导出的元数据。
"""

from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from .. import settings
from ..pipeline import gazebo_export
from ..pipeline.registry import load_meta
from ..pipeline.gazebo_export import GazeboExportError

router = APIRouter(prefix="/api", tags=["gazebo-export"])

_EXPORT_DIR = settings.GAZEBO_EXPORT_DIR


@router.post("/regions/{name}/export/gazebo")
def post_export_gazebo(
    name: str,
    mesh_grid: int = Query(default=None, ge=32, le=1025),
    visual_mesh_grid: int = Query(default=None, ge=32, le=2049),
    tex_size: int = Query(default=None, ge=256, le=4096),
    tex_quality: int = Query(default=None, ge=50, le=100),
    normal_strength: float = Query(default=None, ge=0.0, le=20.0),
    fill_light: float = Query(default=None, ge=0.0, le=2.0),
):
    """导出指定区域的 Gazebo/ROS2 仿真**地图包**（只含地形，无巡视器/传感器）。

    视觉/碰撞分离：collision=heightmap(mesh_grid，物理行为不变)，
    visual=terrain_hi.obj(visual_mesh_grid) + PBR 三件套
    (mars_color.jpg / mars_normal.jpg)。参数不传时取 GAZEBO_DEFAULTS。
    返回产物目录与关键参数；若区域尚未处理（缺 height 二进制）返回 404。
    """
    try:
        load_meta(name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    try:
        result = gazebo_export.export_gazebo(
            name, mesh_grid=mesh_grid,
            visual_mesh_grid=visual_mesh_grid,
            tex_size=tex_size, tex_quality=tex_quality,
            normal_strength=normal_strength, fill_light=fill_light)
    except GazeboExportError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return result


@router.get("/regions/{name}/gazebo")
def get_gazebo_export(name: str):
    """查询该区域是否已导出 Gazebo 包，返回元数据或 404。"""
    meta_path = _EXPORT_DIR / name / "export_meta.json"
    if not meta_path.exists():
        raise HTTPException(status_code=404, detail="尚未导出 Gazebo 包")
    import io, json
    with io.open(meta_path, "r", encoding="utf-8") as fh:
        return json.load(fh)


@router.get("/regions/{name}/gazebo/package")
def download_gazebo_package(name: str,
                            fmt: str = Query(default="zip",
                                             pattern="^(zip|tar.gz)$")):
    """下载整个导出包（默认 zip，可选 tar.gz），便于部署。"""
    from ..pipeline.gazebo_export import package_export

    out_dir = _EXPORT_DIR / name
    if not out_dir.exists():
        raise HTTPException(status_code=404, detail="尚未导出 Gazebo 包")
    try:
        pkg = package_export(name, out_root=out_dir, fmt=fmt)
    except GazeboExportError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    if fmt == "zip":
        return FileResponse(pkg, media_type="application/zip",
                            filename="%s_gazebo.zip" % name)
    return FileResponse(pkg, media_type="application/gzip",
                        filename="%s_gazebo.tar.gz" % name)
