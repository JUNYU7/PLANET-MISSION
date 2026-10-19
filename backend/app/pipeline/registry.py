"""区域注册表读取。

区域元数据与统计信息在数据处理阶段已写入磁盘，此处只负责读取与

对外提供，不重复计算。目录结构即后续 IR 与 Gazebo 导出的输入契约。
"""

import io
import json
from typing import Any, Dict, List, Optional

from ..settings import LAYER_DEFS, REGIONS_INDEX, region_dir

__all__ = ["load_index", "list_regions", "load_meta", "load_stats",
           "layer_manifest", "resolve_layer_path"]


def _read_json(path):
    with io.open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def load_index() -> Dict[str, Any]:
    """读取区域索引。未处理数据时返回空列表而非抛错，便于前端提示。"""
    if not REGIONS_INDEX.exists():
        return {"regions": []}
    try:
        return _read_json(REGIONS_INDEX)
    except (IOError, ValueError):
        return {"regions": []}


def list_regions() -> List[Dict[str, Any]]:
    return list(load_index().get("regions", []))


def load_meta(name: str) -> Dict[str, Any]:
    path = region_dir(name) / "region_meta.json"
    if not path.exists():
        raise FileNotFoundError("区域 %s 尚未处理，缺少 region_meta.json" % name)
    return _read_json(path)


def load_stats(name: str) -> Dict[str, Any]:
    path = region_dir(name) / "env_stats.json"
    if not path.exists():
        raise FileNotFoundError("区域 %s 尚未处理，缺少 env_stats.json" % name)
    return _read_json(path)


def layer_manifest(name: str, tier: str = "interactive") -> Dict[str, Any]:
    """给出指定档位下各图层的实际文件名与色彩空间约定。

    前端据此按 id 请求资源，无需硬编码分辨率相关的文件名。
    """
    meta = load_meta(name)
    grid = int(meta["grids"]["capture" if tier == "capture" else "interactive"])
    tex = int(meta["textures"]["capture" if tier == "capture" else "interactive"])

    names = {
        "color": "color_%d.png" % tex,
        "hillshade": "hillshade_%d.png" % tex,
        "slope": "slope_%d.png" % tex,
        "curvature": "curvature_%d.png" % tex,
        "traversability": "traversability_%d.png" % tex,
        "semantic": "semantic_%d.png" % tex,
    }
    layers = []
    for item in LAYER_DEFS:
        layers.append({
            "id": item["id"],
            "name": item["name"],
            "swatch": item["swatch"],
            "color_space": item["color_space"],
            "file": names.get(str(item["id"])),
            "grid": grid,
        })

    # 细节法线贴图（数据处理阶段生成）。旧区域没有该文件时返回 null，
    # 前端据此跳过 normalMap，保持向后兼容。
    normal_name = "normal_%d.png" % tex
    normal_file = normal_name if (region_dir(name) / normal_name).exists() \
        else None

    # 法线图梯度缩放（数据处理时写入 region_meta.json；旧区域无此字段
    # 时回退 2.5——历史法线图即按该强度生成，前端按 1/strength 补偿）。
    normal_strength = float(meta.get("normal_strength", 2.5))

    return {
        "tier": tier,
        "grid": grid,
        "texture": tex,
        "size_m": meta["size_m"],
        "height_file": "height_%d.bin" % grid,
        "normal_file": normal_file,
        "normal_strength": normal_strength,
        "layers": layers,
    }


def resolve_layer_path(name: str, filename: str):
    """把图层文件名解析为绝对路径，并阻止路径穿越。"""
    from pathlib import Path

    base = region_dir(name).resolve()
    target = (base / filename).resolve()
    if base not in target.parents:
        raise ValueError("非法路径：%s" % filename)
    if not target.exists():
        raise FileNotFoundError("图层文件不存在：%s" % filename)
    return Path(target)

