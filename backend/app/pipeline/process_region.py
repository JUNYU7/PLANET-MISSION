"""区域处理编排：裁剪 → 校验 → 填充 → 指标 → TI → 语义 → 编码写出。

产物落在 dataset_repo/regions/<name>/，目录结构即后续 IR 与 Gazebo 导出的

输入契约，不使用临时目录。
"""

import io
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

import numpy as np

from .. import settings
from ..core import imaging, raster_source, semantic, terrain_metrics
from ..core import detail as detail_mod
from ..core.traversability import (
    classify,
    class_ratios,
    traversability_index,
)
from ..settings import REGIONS, region_dir

__all__ = ["process_region", "process_all"]

# 正射影像暖色调映射端点。取自 V4 第 27.1 节的火星地表配色：
# 亮部赭石 #C99070，暗部深棕 #684E3A。灰度经线性映射后叠暖色，
# 保持地形层次不被压缩，同时贴近真实火星影像的灰褐色调。
TONE_LO = np.array([104, 78, 58], dtype=np.float64)
TONE_HI = np.array([201, 144, 112], dtype=np.float64)

def _apply_warm_tone(gray):
    """为灰度正射影像叠加火星暖色调，输出 RGB uint8。

    用户确认的方案为「灰度 + 色调增强」：HiRISE 全色影像本就是灰度，
    真实火星照片也是灰褐色调。此处做线性色调映射，保持地形层次不丢失，
    避免叠加饱和度导致细节压平。
    """
    t = gray.astype(np.float64) / 255.0
    tint = TONE_LO[None, None, :] + (TONE_HI - TONE_LO)[None, None, :] * \
        t[..., None]
    return np.clip(tint, 0, 255).astype(np.uint8)


def _write_json(path, payload):
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    with io.open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def _normal_map_from_height(h: np.ndarray, strength: float) -> np.ndarray:
    """由高度场生成切空间法线贴图，返回 RGB uint8。

    约定与前端 three.js 一致（V4 第 29 章细节增强）：
    R→u 方向（东，+X）、G→v 方向（北，-Z）、B→表面法线。
    像素 128 表示无倾斜；地形朝某方向抬升时对应通道偏离 128。

    斜率按 strength 缩放（settings.NORMAL_STRENGTH，固定 1.0）：
    strength>1 会使法线图光照斜率大于网格几何实际坡度，低太阳角下
    背光假陡坎全黑、地表出现黑色斑纹，因此必须保持物理一致；
    沙脊波纹的可辨性由真实地形法线自然呈现。

    在目标纹理网格上直接求梯度，而不是把源分辨率法线重采样过来：
    重采样会把法线矢量混合，产生不存在的中间方向。
    """
    gy, gx = np.gradient(h)
    # np.gradient 的第二个返回值沿列（东+）变化，第一个沿行（南+）变化。
    # 切空间 v 向北（-南），故 G 通道符号取正 gy。
    nx = -gx * strength
    ny = gy * strength
    nz = np.ones_like(h)
    norm = np.sqrt(nx * nx + ny * ny + nz * nz)
    rgb = np.stack([nx / norm, ny / norm, nz / norm], axis=-1)
    return np.clip((rgb * 0.5 + 0.5) * 255.0, 0, 255).astype(np.uint8)


def process_region(cfg):
    """处理单个区域，返回统计信息字典。

    流程：读取 DTM 与正射影像窗口 → 正射零值率校验 → 缺失填充 →
    相对化 → 高斯平滑 → 地形指标 → 语义分类 → TI 与三阈值 →
    双网格编码写出。
    """
    name = str(cfg["name"])
    out_dir = region_dir(name)
    out_dir.mkdir(parents=True, exist_ok=True)

    center = cfg["center"]
    lon = float(center["lon"])
    lat = float(center["lat"])
    size_m = float(cfg["size_m"])
    grid_interactive = int(cfg["grids"]["interactive"])
    grid_capture = int(cfg["grids"]["capture"])
    tex_interactive = int(cfg["textures"]["interactive"])
    tex_capture = int(cfg["textures"]["capture"])

    # 源数据按区域指定；未配置时回退到全局默认（Jezero 拼接影像）。
    # 不同区域的 DTM 分辨率与投影各不相同，一律以栅格实测值为准。
    dtm_path = cfg.get("dtm_file") or settings.DTM_FILE
    ortho_path = cfg.get("ortho_file") or settings.ORTHO_FILE

    print("[%s] 读取源数据（中心 %.4fE %.4fN，边长 %.0f m）"
          % (name, lon, lat, size_m))
    print("  DTM   %s" % dtm_path.name)
    print("  ortho %s" % ortho_path.name)

    height, src_n, res_m = raster_source.read_dtm_window(
        dtm_path, lon, lat, size_m)
    print("  DTM 窗口 %d×%d  像元 %.4f m  缺失 %.3f%%"
          % (src_n, src_n, res_m,
             100.0 * float((~np.isfinite(height)).mean())))

    ortho, ortho_valid = raster_source.read_ortho_window(
        ortho_path, lon, lat, size_m)
    zero_ratio = float((~ortho_valid).mean())
    max_zero = float(cfg.get("min_ortho_zero_ratio", 0.05))
    print("  正射窗口 %d×%d  零值 %.3f%%" % (ortho.shape[1], ortho.shape[0],
                                       100.0 * zero_ratio))
    if zero_ratio > max_zero:
        raise ValueError(
            "正射影像有效覆盖率不足：零值 %.2f%% 超过阈值 %.2f%%。"
            "请将区域中心继续向南移动，或更换数据源。" % (100 * zero_ratio,
                                                100 * max_zero))

    height, fill_ratio = raster_source.fill_invalid(height)
    if fill_ratio > 0:
        print("  缺失填充 %.3f%%" % (100.0 * fill_ratio))

    abs_min = float(np.nanmin(height))
    abs_max = float(np.nanmax(height))
    height, base = raster_source.to_relative(height)

    # 分形微起伏（core/detail.py）：在指标计算前注入高度场。
    # 结构化多 octave 噪声（波长 ≥4 m 防混叠）而非白噪声——
    # 坡度/粗糙度/曲率/TI/法线/晕渲全部随之合理地变糙。
    detail_cfg = cfg.get("detail") or {}
    if detail_cfg.get("fbm_enabled", False):
        height = detail_mod.fbm_relief(
            height, detail_cfg, res_m,
            int(detail_cfg.get("fbm_seed", 77123)))
        print("  分形微起伏：%d 个 octave 已注入（波长 ≥4 m）"
              % len(detail_cfg.get("fbm_octaves_m", [])))

    rel_max = float(np.nanmax(height))
    print("  绝对海拔 %.2f ~ %.2f m   相对起伏 0 ~ %.2f m"
          % (abs_min, abs_max, rel_max))

    # 程序化岩石场（21.4 前置）：在源分辨率叠加岩块高程，之后所有指标
    # （坡度/粗糙度/曲率/TI/法线/晕渲）自动反映岩石；掩膜在写出前
    # 覆写语义（巨石）与通行类别（禁行）。
    rock_mask = None
    rock_instances: List[Dict[str, object]] = []
    rocks_cfg = cfg.get("rocks") or {}
    if rocks_cfg.get("enabled", False):
        from ..core import rocks as rocks_mod
        smooth0 = raster_source.smooth_field(height, pixel_size_m=res_m)
        slope0 = terrain_metrics.slope_deg(smooth0, pixel_size_m=res_m)
        rock_data = rocks_mod.generate_rocks(
            height, rocks_cfg, pixel_m=res_m, slope=slope0, size_m=size_m)
        height = rock_data["height"]
        rock_mask = rock_data["mask"]
        rock_instances = rock_data["instances"]
        cover = float(rock_mask.mean()) * 100.0
        print("  岩石场：%d 块（半径 %.2f–%.2f m）  足迹覆盖 %.3f%%"
              % (len(rock_instances),
                 float(rocks_cfg.get("r_min_m", 0.25)),
                 float(rocks_cfg.get("r_max_m", 1.2)), cover))

    return {
        "name": name,
        "out_dir": out_dir,
        "height": height,
        "ortho": ortho,
        "ortho_valid": ortho_valid,
        "abs_elevation_range": [abs_min, abs_max],
        "relative_height_range": [0.0, rel_max],
        "center": {"lon": lon, "lat": lat},
        "size_m": size_m,
        "resolution_m": res_m,
        "src_n": src_n,
        "src_pixel_m": res_m,
        "grid_interactive": grid_interactive,
        "grid_capture": grid_capture,
        "tex_interactive": tex_interactive,
        "tex_capture": tex_capture,
        "ortho_zero_ratio": zero_ratio,
        "rock_mask": rock_mask,
        "rock_instances": rock_instances,
        "cfg": cfg,
    }


def _compute_source_metrics(height, src_pixel_m):
    """在源分辨率上计算全部地形指标。

    必须用源实测分辨率（Jezero 1.0、HiRISE 单景 1.0113 m/px）而非降采样后的
    网格计算：该区域沙脊纹理波长约10–20 m，1.95 m/px 网格已接近其半波长，
    若先降采样再算坡度，细密沙脊会被抹平，坡度中位数偏低、粗糙度被压到
    厘米级，可通行性判定随之失真。平滑的 sigma 以米给出，因此源分辨率与
    网格分辨率下的平滑强度并不相同。
    """
    smooth = raster_source.smooth_field(height, pixel_size_m=src_pixel_m)
    slope = terrain_metrics.slope_deg(smooth, pixel_size_m=src_pixel_m)
    curv = terrain_metrics.curvature(smooth, pixel_size_m=src_pixel_m)
    rough = terrain_metrics.roughness(smooth)
    sem = semantic.classify_semantic(smooth, slope, curv)
    sem_score = semantic.semantic_scores(sem)
    ti = traversability_index(slope, rough, sem_score, curv)
    classes, _ = classify(ti)
    return {
        "smooth": smooth, "slope": slope, "curv": curv, "rough": rough,
        "sem": sem, "ti": ti, "classes": classes,
    }


def _write_outputs(ctx):
    """在目标网格上写出全部产物文件。

    指标在源分辨率计算后重采样到输出网格：高程与连续指标用双线性，
    类别栅格用最近邻（双线性会混合类别，产生不存在的取值）。
    """
    name = ctx["name"]
    out_dir = ctx["out_dir"]
    size_m = ctx["size_m"]
    height = ctx["height"]
    rock_mask = ctx.get("rock_mask")
    rock_instances = ctx.get("rock_instances") or []
    detail_cfg = (ctx.get("cfg") or {}).get("detail") or {}
    # 源像元边长由 read_dtm_window 从栅格 transform 实测得到（Jezero 1.0、
    # HiRISE 单景 1.0113 m/px），不再用 size_m/(src_n-1) 反推：反推等价于
    # 假定「请求的米数就是像素数」，在源像元非整米时会引入系统偏差。
    src_pixel_m = float(ctx["src_pixel_m"])

    metrics = _compute_source_metrics(height, src_pixel_m)
    print("  源分辨率指标：坡度中位数 %.2f°  粗糙度中位数 %.4f m"
          % (float(np.median(metrics["slope"])),
             float(np.median(metrics["rough"]))))

    # 源影像实际覆盖范围：用于球体视图圈出真实footprint，
    # 而非用一个抽象圆点表示区域位置
    import rasterio

    from ..core import coords as coord_mod

    footprint = None
    ortho_path = ctx["cfg"].get("ortho_file") or settings.ORTHO_FILE
    with rasterio.open(ortho_path) as ds:
        # crs 必须传源栅格的真实投影：HiRISE 单景 ortho 的中央经线非 0，
        # 漏传会让球体视图上的区域包围盒整体错位。
        footprint = coord_mod.footprint_bbox(ds.transform, ds.bounds, ds.crs)
    ctx["footprint"] = footprint
    print("  源影像覆盖 %.0f × %.0f m  经纬度 %.4f~%.4fE  %.4f~%.4fN"
          % (footprint["width_m"], footprint["height_m"],
             footprint["lon_min"], footprint["lon_max"],
             footprint["lat_min"], footprint["lat_max"]))

    gray_full = raster_source.percentile_stretch(
        ctx["ortho"], ctx["ortho_valid"])
    if rock_instances:
        # 岩石绘制进正射灰度影像（源 0.25 m/px）：与高度场叠加使用
        # 同一组足迹参数，贴图明暗与栅格 bump 对齐
        from ..core import rocks as rocks_mod
        gray_full = rocks_mod.paint_rocks_into_gray(
            gray_full, rock_instances, size_m)
        _write_json(
            out_dir / "rocks.json",
            rocks_mod.instances_payload(
                rock_instances, size_m, ctx["grid_interactive"]))
        print("  岩石已绘制入正射影像，实例清单写出 rocks.json")
    shade_src = terrain_metrics.hillshade(metrics["smooth"],
                                          pixel_size_m=src_pixel_m)

    for grid in (ctx["grid_interactive"], ctx["grid_capture"]):
        tag = "交互档" if grid == ctx["grid_interactive"] else "出图档"

        h = raster_source.resample_to_grid(height, grid)
        height_bin = out_dir / ("height_%d.bin" % grid)
        height_bin.write_bytes(
            np.ascontiguousarray(h, dtype=np.float32).tobytes())

        slope = raster_source.resample_to_grid(metrics["slope"], grid)
        curv = raster_source.resample_to_grid(metrics["curv"], grid)
        classes = raster_source.resample_nearest(metrics["classes"], grid)
        sem = raster_source.resample_nearest(metrics["sem"], grid)
        if rock_instances:
            # 岩石足迹覆写：语义=巨石(3)、通行=禁行(3)。
            # 直接在目标栅格上印签而非重采样源掩膜——小石（半径
            # <1 m）在降采样中会被整块丢弃，印签保底每石一格。
            from ..core import rocks as rocks_mod
            rm = rocks_mod.stamp_mask(rock_instances, grid, size_m)
            sem = np.where(rm, semantic.SEM_BOULDER, sem)
            classes = np.where(rm, 3, classes)

        tex_n = ctx["tex_interactive"] if grid == ctx["grid_interactive"] \
            else ctx["tex_capture"]

        gray_tex = raster_source.resample_to_grid(
            gray_full.astype(np.float64), tex_n).astype(np.uint8)
        # 正射高通增强：重采样的低通把 3 m 以下反差削平了，unsharp
        # 在纹理分辨率上补回（sigma 单位为纹理像元）
        if detail_cfg.get("unsharp_amount", 0) > 0:
            gray_tex = detail_mod.unsharp(
                gray_tex, float(detail_cfg.get("unsharp_amount", 0.55)),
                float(detail_cfg.get("unsharp_sigma_px", 1.5)))
        imaging.save_rgb(out_dir / ("color_%d.png" % tex_n),
                         _apply_warm_tone(gray_tex))

        shade_tex = raster_source.resample_to_grid(
            shade_src.astype(np.float64), tex_n).astype(np.uint8)
        imaging.save_gray(out_dir / ("hillshade_%d.png" % tex_n), shade_tex)

        # 细节法线贴图：大波长来自平滑高程，高频细节由程序化噪声
        # 叠加（UDN 式混合），补偿网格降采样丢失的微观几何
        normal_h = raster_source.resample_to_grid(
            metrics["smooth"].astype(np.float64), tex_n)
        normal_rgb = _normal_map_from_height(normal_h,
                                             settings.NORMAL_STRENGTH)
        normal_rgb = detail_mod.detail_normal(
            normal_rgb, detail_cfg, size_m,
            int(detail_cfg.get("fbm_seed", 77123)))
        imaging.save_rgb(
            out_dir / ("normal_%d.png" % tex_n), normal_rgb)

        # 粗糙度图：基础值 + 噪声变化 + 坡度上浮，供前端 material
        # roughnessMap 使用，使光照不再一片均匀
        slope_tex = raster_source.resample_to_grid(
            metrics["slope"].astype(np.float64), tex_n)
        imaging.save_gray(
            out_dir / ("roughness_%d.png" % tex_n),
            detail_mod.roughness_texture(
                tex_n, size_m, slope_tex, detail_cfg,
                int(detail_cfg.get("fbm_seed", 77123))))

        imaging.save_slope_png(
            out_dir / ("slope_%d.png" % tex_n),
            raster_source.resample_to_grid(slope, tex_n))
        imaging.save_curvature_png(
            out_dir / ("curvature_%d.png" % tex_n),
            raster_source.resample_to_grid(curv, tex_n))
        imaging.save_traversability_png(
            out_dir / ("traversability_%d.png" % tex_n),
            raster_source.resample_nearest(classes, tex_n))
        imaging.save_semantic_png(
            out_dir / ("semantic_%d.png" % tex_n),
            raster_source.resample_nearest(sem, tex_n))

        if grid == ctx["grid_interactive"]:
            # 地形查询栅格（第 21 章）：TI 与语义的数值版（非渲染图），
            # 供 terrain_query 模块与查询 API 使用，保证前端、训练
            # 环境、Gazebo 三处对地形的理解同源。
            (out_dir / ("classes_%d.u8" % grid)).write_bytes(
                np.ascontiguousarray(classes, dtype=np.uint8).tobytes())
            (out_dir / ("sem_%d.u8" % grid)).write_bytes(
                np.ascontiguousarray(sem, dtype=np.uint8).tobytes())

            ok, slow, forbid, band_ratio = class_ratios(classes)
            ctx["stats"] = {
                "pass_ratio": round(ok, 4),
                "slow_ratio": round(slow, 4),
                "forbidden_ratio": round(forbid, 4),
                "band_ratio": round(band_ratio, 4),
                "grid": grid,
                "rock_count": len(rock_instances),
                "rock_cover_pct": round(
                    float(rock_mask.mean()) * 100.0, 4)
                if rock_mask is not None else 0.0,
                "mean_slope_deg": round(float(metrics["slope"].mean()), 2),
                "median_slope_deg": round(float(np.median(metrics["slope"])), 2),
                "max_slope_deg": round(float(metrics["slope"].max()), 2),
                "mean_roughness_m": round(float(metrics["rough"].mean()), 4),
                "p95_slope_deg": round(
                    float(np.percentile(metrics["slope"], 95)), 2),
                "cells_over_15deg_pct": round(
                    float((metrics["slope"] > 15).mean() * 100), 2),
                "ti_median": round(float(np.median(metrics["ti"])), 4),
            }
        print("  %s 网格 %d² 写出完成" % (tag, grid))

    return ctx


def _load_prev_index():
    """读取现有区域索引，返回 {name: 条目}。

    仅重跑部分区域时，未重跑区域的条目必须原样保留，否则索引会被裁剪成
    只剩本次处理的那一个，前端球体视图上的其它区域随之消失。
    """
    if not settings.REGIONS_INDEX.exists():
        return {}
    try:
        with io.open(settings.REGIONS_INDEX, encoding="utf-8") as fh:
            payload = json.load(fh)
        return {str(item["name"]): item for item in payload.get("regions", [])}
    except (ValueError, KeyError, OSError):
        return {}


def process_all(only=None):
    """处理已注册区域，并更新区域索引。

    only 为区域名序列时只处理这些区域（新增区域迭代时避免重跑全量）；
    索引仍按 REGIONS 的注册顺序重写，未重跑的条目从旧索引继承。
    """
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8",
                                  errors="replace")
    if only:
        wanted = {str(n) for n in only}
        cfgs = [c for c in REGIONS if str(c["name"]) in wanted]
        missing = wanted - {str(c["name"]) for c in cfgs}
        if missing:
            raise ValueError("未注册的区域：%s" % ", ".join(sorted(missing)))
        print("仅处理：%s\n" % ", ".join(str(c["name"]) for c in cfgs))
    else:
        cfgs = REGIONS

    merged = _load_prev_index()
    for cfg in cfgs:
        ctx = process_region(cfg)
        ctx = _write_outputs(ctx)

        meta = {
            "name": ctx["name"],
            "body": str(ctx["cfg"]["body"]),
            "landing_site": ctx["cfg"]["landing_site"],
            "center": ctx["center"],
            "size_m": ctx["size_m"],
            "resolution_m": ctx["resolution_m"],
            "crs": ctx["cfg"]["crs"],
            "source": ctx["cfg"]["source"],
            "license": ctx["cfg"]["license"],
            "license_note": ctx["cfg"]["license_note"],
            "resolution_source": ctx["cfg"]["resolution_source"],
            "elevation_absolute_range": [round(v, 3)
                                          for v in ctx["abs_elevation_range"]],
            "height_range": [round(v, 3)
                             for v in ctx["relative_height_range"]],
            "grids": ctx["cfg"]["grids"],
            "textures": ctx["cfg"]["textures"],
            "ortho_zero_ratio": round(ctx["ortho_zero_ratio"], 6),
            "normal_strength": settings.NORMAL_STRENGTH,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
        _write_json(ctx["out_dir"] / "region_meta.json", meta)
        _write_json(ctx["out_dir"] / "env_stats.json", ctx["stats"])

        merged[ctx["name"]] = {
            "name": ctx["name"],
            "center": ctx["center"],
            "landing_site": ctx["cfg"]["landing_site"],
            "footprint": ctx["footprint"],
            "size_m": ctx["size_m"],
            "height_range": meta["height_range"],
            "stats": ctx["stats"],
        }
        print("[%s] 完成\n" % ctx["name"])

    # 按 REGIONS 的注册顺序输出，保证增量处理后顺序稳定
    ordered = [merged[str(c["name"])] for c in REGIONS
               if str(c["name"]) in merged]
    _write_json(settings.REGIONS_INDEX, {"regions": ordered})
    print("区域索引已更新（%d 个区域）：%s"
          % (len(ordered), settings.REGIONS_INDEX))
    return 0

