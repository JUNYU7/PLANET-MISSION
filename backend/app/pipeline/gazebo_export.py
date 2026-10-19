"""Gazebo / ROS2 场景导出。

把数据处理阶段生成的区域产物（相对高程二进制、火星暖色正射纹理）
转换为可直接在 Gazebo 中运行的仿真包：

    dataset_repo/gazebo/<name>/
        world/<name>.world              # Gazebo 世界（火星重力、光照、地形）
        models/<name>_terrain/          # 静态地形模型（目录名 = model:// 名）
            model.config
            model.sdf                    # 视觉/碰撞分离：collision=heightmap(257)，
                                         # visual=terrain_hi.obj(1025) + PBR 三件套
            mars_height.png              # 16-bit 灰度高度图（碰撞，257）
            terrain.obj                  # 旧 257 视觉网格（保留作回退）
            terrain_hi.obj               # 新 1025 视觉网格（带 UV）
            mars_color.jpg               # 4096 albedo（JPG q90）
            mars_normal.jpg              # 4096 法线（OpenGL +Y 约定）
        launch/<name>.launch.py          # ROS2 启动：启动 Gazebo
        package.xml
        CMakeLists.txt
        export_meta.json                 # 导出参数与溯源信息

**本包只导地图**：不含任何巡视器模型、传感器、机械臂或驱动插件。
巡视器（含相机/雷达）由用户自行决定放入 models/；任务标记与 spawn
推荐点信息保留（后者是地图元数据，见 export_meta.json / README）。

设计取舍（见 V4 第 19 章）：
- **视觉与碰撞分离**：collision 用 Gazebo 原生 <heightmap>（257²，
  物理稳定、仿真不减速，一行不改）；visual 换 1025² 高密度网格
  + 4096 JPG PBR 贴图（albedo/normal），观感贴近 three.js。
- **PBR 必须 metal workflow + 低 metalness**：<metal> 下只给
  albedo_map 会渲染纯黑（metal workflow 默认 metalness=1，无
  环境光可反射），必须显式 <metalness>0.05</metalness>。
- **法线图 Y 通道用 OpenGL 约定**（+Y = 纹理 v = 北）：符号写反
  会使光照方向整体反向，地貌「凹地变山脊」。
"""

import io
import json
import math
import os
import tarfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
from PIL import Image

from .. import settings
from ..pipeline import registry
from ..settings import GAZEBO_DEFAULTS, GAZEBO_EXPORT_DIR, region_dir
from ..core import raster_source

__all__ = ["export_gazebo", "GazeboExportError"]


def _package_name(region: str) -> str:
    """该区域导出包使用的 ROS2/Gazebo 包名。

    历史实现从 GAZEBO_DEFAULTS 读取全局写死的 "jezero_gazebo"，多区域
    导出会互相撞名：CMake 的 project() 冲突、ros2 launch 指向错误的包。
    现按区域名派生，区域配置可用 "gazebo_package" 显式覆盖以保持历史包名
    （Jezero 即如此，导出目录与 README 都以 jezero_gazebo 为准）。
    """
    for r in settings.REGIONS:
        if str(r["name"]) == region:
            explicit = r.get("gazebo_package")
            if explicit:
                return str(explicit)
            break
    suffix = str(GAZEBO_DEFAULTS.get("package_suffix", "_gazebo"))
    # ROS2 包名只允许小写字母、数字与下划线
    safe = "".join(c if (c.islower() or c.isdigit() or c == "_") else "_"
                    for c in str(region).lower())
    return "%s%s" % (safe, suffix)


class GazeboExportError(RuntimeError):
    """导出阶段的可预期错误（缺产物、参数非法等）。"""


# ---------------------------------------------------------------- 工具


def _read_json(path: Path) -> Dict[str, Any]:
    with io.open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with io.open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


def _write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


# ---------------------------------------------------------------- 高程读取


def _load_height_field(name: str):
    """读取已生成的交互档相对高程二进制，返回 (height, grid)。"""
    meta = registry.load_meta(name)
    grid = int(meta["grids"]["interactive"])
    path = region_dir(name) / ("height_%d.bin" % grid)
    if not path.exists():
        raise GazeboExportError(
            "缺少高程二进制 %s，请先运行数据处理（process_region）。" % path)
    raw = path.read_bytes()
    arr = np.frombuffer(raw, dtype=np.float32).reshape(grid, grid)
    return arr.astype(np.float64), grid, meta


def _load_visual_height(name: str, target_grid: int) -> np.ndarray:
    """加载视觉网格用的高度场（target_grid × target_grid）。

    优先取 ≥ target 的最小档产物（1025 视觉用交互档、2049 用
    capture 档，都是真实数据不插值）；没有更大档时用最大档重采样
    （仅为凑分辨率，不增细节）。碰撞高度图不经过这里——它始终用
    mesh_grid 从交互档降采样，物理行为与视觉网格彻底解耦。
    """
    meta = registry.load_meta(name)
    available = []
    for key in ("interactive", "capture"):
        g = int(meta["grids"][key])
        p = region_dir(name) / ("height_%d.bin" % g)
        if p.exists():
            available.append((g, p))
    if not available:
        raise GazeboExportError("缺少高程二进制，请先运行数据处理。")
    available.sort()
    pick = None
    for g, p in available:
        if g >= target_grid:
            pick = (g, p)
            break
    if pick is None:
        pick = available[-1]
    g, p = pick
    arr = np.frombuffer(p.read_bytes(), dtype=np.float32).reshape(g, g)
    arr = arr.astype(np.float64)
    if g != target_grid:
        arr = raster_source.resample_to_grid(arr, target_grid)
    return arr


def _height_at(hm: np.ndarray, size_m: float, ex: float, ey: float) -> float:
    """双线性采样某物理坐标 (东 ex, 北 ey，单位 m，原点为区域中心) 处的高程。"""
    n = hm.shape[0]
    fx = (ex / size_m + 0.5) * (n - 1)
    fy = (ey / size_m + 0.5) * (n - 1)
    fx = float(np.clip(fx, 0, n - 1))
    fy = float(np.clip(fy, 0, n - 1))
    x0, y0 = int(math.floor(fx)), int(math.floor(fy))
    x1, y1 = min(x0 + 1, n - 1), min(y0 + 1, n - 1)
    tx, ty = fx - x0, fy - y0
    h00 = hm[y0, x0]
    h10 = hm[y0, x1]
    h01 = hm[y1, x0]
    h11 = hm[y1, x1]
    return (h00 * (1 - tx) + h10 * tx) * (1 - ty) + \
           (h01 * (1 - tx) + h11 * tx) * ty


def _find_spawn(height: np.ndarray, size_m: float,
                patch_m: float = 100.0,
                slope_max_deg: float = 5.0) -> Dict[str, Any]:
    """在全区搜索推荐出生点（要求 7）。

    在源分辨率高程（1 m/px）上以 3×3 像素梯度评估坡度，再用
    maximum_filter 求每个位置 patch_m×patch_m 邻域内的最大坡度，
    取全域最大坡度最小（且尽量靠近图幅中心）的位置作为推荐点。
    车辆应被 spawn 在该点地形表面上方 0.3~0.5 m 处自由落下着陆，
    不能假设地面在 z=0。

    坐标约定与导出网格一致：world_x 向东、world_y 向南（北为 -y）、
    ground_z 为相对高程（即 Gazebo 世界坐标 z）。

    若全域不存在满足 <5° 的补丁（会出现在沙脊密集区），返回全域
    最平坦的补丁并给出实际 worst_case_slope_deg，同时置
    meets_5deg=False，供上层提示用户。
    """
    from scipy import ndimage

    from ..core import raster_source, terrain_metrics

    n = height.shape[0]
    px = size_m / float(n - 1)
    smooth = raster_source.smooth_field(height, pixel_size_m=px)
    slope = terrain_metrics.slope_deg(smooth, pixel_size_m=px)

    # 4×4 分块取最大值降采样后再做邻域最大值滤波：
    # 1025² 上直接开 101×101 窗口太慢，分块后 256²、窗口 25² 等价
    # （块内取 max 与滑窗取 max 语义一致，仅窗口对齐差 ≤4 m）。
    pool = 4
    nd = n // pool
    slope_ds = slope[:nd * pool, :nd * pool] \
        .reshape(nd, pool, nd, pool).max(axis=(1, 3))
    px_ds = px * pool
    win = int(round(patch_m / px_ds)) | 1  # 奇数窗口
    win = max(3, win)
    worst = ndimage.maximum_filter(slope_ds, size=win, mode="nearest")

    # 排除贴边窗口（补丁不完整）
    margin = win // 2
    worst[:margin, :] = np.inf
    worst[-margin:, :] = np.inf
    worst[:, :margin] = np.inf
    worst[:, -margin:] = np.inf

    j, i = np.unravel_index(int(np.argmin(worst)), worst.shape)
    worst_case = float(worst[j, i])
    x = ((i + 0.5) * pool / (n - 1) - 0.5) * size_m
    y = ((j + 0.5) * pool / (n - 1) - 0.5) * size_m
    ground_z = float(_height_at(height, size_m, x, y))
    return {
        "world_x": round(x, 2),
        "world_y": round(y, 2),
        "ground_z": round(ground_z, 3),
        "worst_case_slope_deg": round(worst_case, 2),
        "patch_size_m": round(win * px_ds, 1),
        "meets_5deg": bool(worst_case < slope_max_deg),
        "note": (
            "在源分辨率 DTM 上以 3×3 像素梯度评估坡度；"
            "搜索 ≥%.0f m × %.0f m 且最大坡度 <%.0f° 的补丁。"
            "spawn 高度取 ground_z + 0.4 m 自由落下着陆。"
            "world_y 向南为正（北为 -y）。"
            % (patch_m, patch_m, slope_max_deg)
        ),
    }


# ---------------------------------------------------------------- 高度图 / 网格


def _export_heightmap(hm: np.ndarray, out_dir: Path) -> float:
    """写出 16-bit 灰度高度图，返回 size.z 应使用的实际高度。

    高度图像素值线性映射到 <size> 第三项：实际高程 = value/65535 × size.z。
    因此归一化基准必须取本图自身的最大高程——若沿用源 DTM 全图最大值，
    降采样（含高斯平滑）后的图最大像素达不到 65535，解码高程会整体
    偏低数个百分点（实测 64335/65535 ≈ 2%），违反标定一致性（要求 6）。
    与源 DTM 全图高差的差值在 export_meta.json 中注明来源。
    """
    hm_max = float(np.nanmax(hm))
    norm = np.clip(hm / hm_max, 0.0, 1.0)
    png16 = (norm * 65535.0).round().astype(np.uint16)
    Image.fromarray(png16, mode="I;16").save(str(out_dir / "mars_height.png"))
    return hm_max


def _export_color_texture(name: str, out_dir: Path, tex_size: int,
                          quality: int = 90) -> None:
    """复用已生成的火星暖色正射纹理，降采样到 tex_size，存为 JPG。

    用 JPG 而非 PNG：4096 PNG 20–50 MB，gz 解码慢；quality 90 的
    JPG 约 2–4 MB，目视无差。源优先取 capture 档（4096），交互档
    （2048）作回退——小于目标尺寸的源不选（放大不增细节）。
    """
    meta = registry.load_meta(name)
    src = None
    for key in ("capture", "interactive"):
        tex = int(meta["textures"][key])
        path = region_dir(name) / ("color_%d.png" % tex)
        if path.exists() and tex >= tex_size:
            src = path
            break
    if src is None:
        for key in ("interactive", "capture"):
            tex = int(meta["textures"][key])
            path = region_dir(name) / ("color_%d.png" % tex)
            if path.exists():
                src = path
                break
    if src is None:
        raise GazeboExportError("缺少彩色纹理，无法导出贴图。")
    img = Image.open(str(src)).convert("RGB")
    if img.width != tex_size:
        img = img.resize((tex_size, tex_size), Image.LANCZOS)
    img.save(str(out_dir / "mars_color.jpg"), quality=quality, optimize=True)


def _export_normal_map(hm: np.ndarray, size_m: float, out_dir: Path,
                       tex_size: int, strength: float,
                       quality: int = 90) -> None:
    """由高分辨率高度场程序化生成切线空间法线图（mars_normal.jpg）。

    约定（实测踩坑）：**OpenGL 式切线空间，+Y = 纹理 v 方向 = 北**。
    网格 row0 在北、col0 在西；UV 与 terrain_hi.obj 一致（u=0 西、
    v=1 北）。高度场梯度 gy 向南、gx 向东，于是：
        n ∝ (-dh/du, -dh/dv, 1)，dh/dv(北) = -gy
        → x = -gx·s, y = +gy·s, z = 1
    Y 通道符号写反会使光照方向整体反向，地貌看起来「凹地变山脊」。
    强度 s 在 55 m/2000 m 尺度下 2–5 目测自然（默认 3.0）。

    源用 1025（或 2049）的高分辨率高度场而非 257 碰撞图——257 上
    的梯度被平滑得只剩大波形，细节全在降采样中丢失。
    """
    gy, gx = np.gradient(hm)
    nx = -gx * float(strength)
    ny = gy * float(strength)
    nz = np.ones_like(hm)
    norm = np.sqrt(nx * nx + ny * ny + nz * nz)
    rgb = np.stack([nx / norm, ny / norm, nz / norm], axis=-1)
    img = Image.fromarray(
        (np.clip(rgb * 0.5 + 0.5, 0.0, 1.0) * 255.0).astype(np.uint8))
    if img.width != tex_size:
        img = img.resize((tex_size, tex_size), Image.BILINEAR)
    img.save(str(out_dir / "mars_normal.jpg"), quality=quality, optimize=True)


def _export_obj(hm: np.ndarray, size_m: float, out_dir: Path,
                filename: str = "terrain.obj") -> None:
    """生成与高度图同源的 OBJ 网格（visual 用 mesh + PBR）。

    坐标：Gazebo 为 Z 上，X 东、Y 南（栅格 row0 在北，映射为 -Y，
    与 world 中 spawn 的 world_y 约定一致）。顶点 (X, Y, H)，
    H 为相对高程。三角面绕序取 (a,b,c)/(a,c,d) 使法线指向 +Z。

    UV：vt 行 + f v/vt 格式（缺 UV 的 OBJ 在 gz 里贴不上图）。
    约定与高度图/mars_color.jpg 一致：北端（y=-size/2）对应 v=1，
    西端（x=-size/2）对应 u=0。
    """
    n = hm.shape[0]
    lines: List[str] = ["# PlanetMission Mars terrain mesh", "o terrain"]
    for i in range(n):
        for j in range(n):
            x = (j / (n - 1) - 0.5) * size_m
            y = (i / (n - 1) - 0.5) * size_m
            hgt = float(hm[i, j])
            lines.append("v %.4f %.4f %.4f" % (x, y, hgt))
            lines.append("vt %.6f %.6f" % (j / (n - 1), 1.0 - i / (n - 1)))
    for i in range(n - 1):
        for j in range(n - 1):
            a = i * n + j + 1
            b = i * n + (j + 1) + 1
            c = (i + 1) * n + (j + 1) + 1
            d = (i + 1) * n + j + 1
            lines.append("f %d/%d %d/%d %d/%d" % (a, a, b, b, c, c))
            lines.append("f %d/%d %d/%d %d/%d" % (a, a, c, c, d, d))
    _write_text(out_dir / filename, "\n".join(lines) + "\n")


# ---------------------------------------------------------------- SDF 生成


def _terrain_model_sdf(name: str, size_m: float, max_h: float,
                       sdf_version: str, pbr: bool = True) -> str:
    """静态地形模型 SDF。

    要求 4：模型目录内资源的 URI 直接写纯文件名（gz 相对 model.sdf
    所在目录解析）；file://xxx.png 会被当作「主机名为 xxx 的 URL」
    而解析失败。

    要求 5（视觉/碰撞分离）：collision 用 heightmap（257²，物理
    碰撞精确且一步不改）；visual 禁用 heightmap——gz Harmonic 会为
    heightmap visual 自动生成 __default__ 法线贴图材质，导致
    "uri [default] could not be resolved"、整个 world 加载失败。
    visual 改用 1025² 高密度 OBJ（terrain_hi.obj）+ PBR 三件套。

    PBR 必须 metal workflow + 低 metalness：<metal> 下只写
    albedo_map 会渲染纯黑（metal workflow 默认 metalness=1，金属
    没有可反射的环境就是黑的），必须显式 metalness/roughness。
    <diffuse> 只接受 RGBA 颜色，填 URI 会让整个 model 解析失败。

    要求 6：<size> 第三项 = 本高度图最大像素（65535）对应的实际
    高度，即导出网格实测最大相对高程；与源 DTM 全图高差的差值
    （降采样平滑所致，<0.5 m）在 export_meta.json 的 heightmap 字段
    中注明。

    pbr=False 时退回纯 albedo（旧行为，仅调试用）。
    """
    if pbr:
        material_block = """        <material>
          <pbr>
            <metal>
              <albedo_map>mars_color.jpg</albedo_map>
              <normal_map>mars_normal.jpg</normal_map>
              <metalness>0.05</metalness>
              <roughness>0.9</roughness>
            </metal>
          </pbr>
        </material>"""
    else:
        material_block = """        <material>
          <pbr>
            <metal>
              <albedo_map>mars_color.jpg</albedo_map>
            </metal>
          </pbr>
        </material>"""
    return f"""<?xml version="1.0"?>
<sdf version="{sdf_version}">
  <model name="{name}_terrain">
    <static>true</static>
    <link name="terrain_link">
      <collision name="terrain_col">
        <geometry>
          <heightmap>
            <uri>mars_height.png</uri>
            <size>{size_m:.1f} {size_m:.1f} {max_h:.3f}</size>
            <pos>0 0 0</pos>
            <sampling>1</sampling>
          </heightmap>
        </geometry>
      </collision>
      <visual name="terrain_vis">
        <geometry>
          <mesh>
            <uri>terrain_hi.obj</uri>
          </mesh>
        </geometry>
{material_block}
      </visual>
    </link>
  </model>
</sdf>
"""


def _model_config(name: str, sdf_file: str, desc: str) -> str:
    return f"""<?xml version="1.0"?>
<model>
  <name>{name}</name>
  <version>1.0</version>
  <sdf version="{GAZEBO_DEFAULTS['sdf_version']}">{sdf_file}</sdf>
  <author>
    <name>PlanetMission</name>
    <email>planetmission@example.org</email>
  </author>
  <description>{desc}</description>
</model>
"""


def _world_sdf(name: str, waypoints: List[Dict[str, Any]],
               sdf_version: str, spawn: Dict[str, Any],
               fill_light: float = 0.2) -> str:
    """世界文件：火星重力 + 暖色天空 + 太阳 + 补光 + 地形。

    要求 1：必须显式声明 Physics / UserCommands / SceneBroadcaster
    三个核心系统插件。gz Harmonic 的 world 缺了它们就没有物理引擎、
    没有 pose/info 话题，所有 spawn 请求永远挂起且无任何报错。

    要求 2：重力沿 -z（火星表面重力 3.71 m/s²，竖直向下），配
    max_step_size 0.01 / real_time_update_rate 60。

    氛围贴近 three.js 参考：ambient 提亮到 0.55 0.40 0.32 1、
    background 暖橙 0.80 0.55 0.42 1；另加一盏太阳反方向的低强度
    补光（不投影）——单 directional sun 下背光面接近全黑，与
    three.js 的天空光/环境光观感差距明显。

    要求 8：world 只放地形、光照、天空，不放任何虚构插件。
    本包只导地图：不含巡视器/传感器；任务标记由用户任务数据注入。
    """
    wp_blocks = []
    colors = {"pass": "0.2 0.8 0.3 1", "slow": "1.0 0.84 0.0 1",
              "forbidden": "1.0 0.23 0.19 1"}
    for k, wp in enumerate(waypoints):
        col = colors.get(wp.get("kind", "pass"), "0.2 0.8 0.3 1")
        wp_blocks.append(f"""
    <model name="waypoint_{k}">
      <static>true</static>
      <pose>{wp['x']:.2f} {wp['y']:.2f} {wp['z'] + 0.25:.2f} 0 0 0</pose>
      <link name="link">
        <collision name="col"><geometry><cylinder><radius>0.25</radius><length>0.5</length></cylinder></geometry></collision>
        <visual name="vis">
          <geometry><cylinder><radius>0.25</radius><length>0.5</length></cylinder></geometry>
          <material><color><r>{col.split()[0]}</r><g>{col.split()[1]}</g><b>{col.split()[2]}</b><a>1</a></color></material>
        </visual>
      </link>
    </model>""")

    # 补光：太阳反方向（西北低位）低强度，不投影；压回背光面细节
    fill_block = ""
    if fill_light > 0:
        fill_block = f"""
    <light type="directional" name="sun_fill">
      <cast_shadows>false</cast_shadows>
      <diffuse>{fill_light:.2f} {fill_light * 0.9:.2f} {fill_light * 0.8:.2f} 1</diffuse>
      <specular>{fill_light * 0.25:.2f} {fill_light * 0.25:.2f} {fill_light * 0.25:.2f} 1</specular>
      <direction>0.55 0.55 -0.7</direction>
      <attenuation><range>1000</range><constant>0.9</constant><linear>0.01</linear><quadratic>0.001</quadratic></attenuation>
      <pose>-200 -200 300 0 0 0</pose>
    </light>"""

    return f"""<?xml version="1.0"?>
<sdf version="{sdf_version}">
  <world name="{name}_mars">
    <!-- 核心系统插件（要求 1）：缺失则无物理引擎、无 pose/info 话题，
         spawn 请求永远挂起且无报错 -->
    <plugin filename="gz-sim-physics-system"
            name="gz::sim::systems::Physics"/>
    <plugin filename="gz-sim-user-commands-system"
            name="gz::sim::systems::UserCommands"/>
    <plugin filename="gz-sim-scene-broadcaster-system"
            name="gz::sim::systems::SceneBroadcaster"/>

    <physics name="mars_physics" type="ode">
      <real_time_update_rate>60</real_time_update_rate>
      <max_step_size>0.01</max_step_size>
      <!-- 火星表面重力 3.71 m/s²，方向竖直向下（-z）（要求 2） -->
      <gravity>0 0 -3.71</gravity>
      <magnetic_field>0 0 0</magnetic_field>
    </physics>

    <scene>
      <ambient>0.55 0.40 0.32 1</ambient>
      <background>0.80 0.55 0.42 1</background>
      <shadows>true</shadows>
    </scene>

    <light type="directional" name="sun">
      <cast_shadows>true</cast_shadows>
      <diffuse>1.0 0.82 0.70 1</diffuse>
      <specular>0.30 0.30 0.30 1</specular>
      <direction>-0.55 -0.55 -0.7</direction>
      <attenuation><range>1000</range><constant>0.9</constant><linear>0.01</linear><quadratic>0.001</quadratic></attenuation>
      <pose>200 200 300 0 0 0</pose>
    </light>
{fill_block}

    <include>
      <uri>model://{name}_terrain</uri>
    </include>
{ "".join(wp_blocks) }
  </world>
</sdf>
"""


def _launch_py(name: str) -> str:
    """ROS2 启动文件：设置 Gazebo 资源路径并启动世界。

    本包只导地图：不含巡视器，因此没有 ros_gz 网桥；用户自行放入
    models/ 的模型可再用 ros_gz_bridge 接入 ROS2 话题。
    """
    return f'''"""PlanetMission 导出的火星地形场景 ROS2 启动文件。

直接运行（无需编译安装）：
    ros2 launch {_package_name(name)} {name}.launch.py

需要：ros_gz（ROS2 ↔ Gazebo Sim）。若使用 Gazebo Classic，请改用
gazebo_ros 相关启动方式，详见 README.md。
"""
import os

from launch import LaunchDescription
from launch.actions import ExecuteProcess, DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration

_EXPORT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_WORLD = os.path.join(_EXPORT_DIR, "world", "{name}.world")
_MODELS = os.path.join(_EXPORT_DIR, "models")


def generate_launch_description():
    return LaunchDescription([
        DeclareLaunchArgument(
            "world", default_value=_WORLD,
            description="Gazebo world 文件路径"),
        ExecuteProcess(
            cmd=["gz", "sim", "-r", LaunchConfiguration("world")],
            output="screen",
            environment={{"GZ_SIM_RESOURCE_PATH": _MODELS}},
        ),
    ])
'''


def _package_xml(pkg: str) -> str:
    return f'''<?xml version="1.0"?>
<package format="3">
  <name>{pkg}</name>
  <version>0.1.0</version>
  <description>PlanetMission exported Mars terrain map package (Gazebo + ROS2).</description>
  <maintainer email="planetmission@example.org">PlanetMission</maintainer>
  <license>NASA PDS / USGS Astrogeology (derived data)</license>
  <buildtool_depend>ament_cmake</buildtool_depend>
  <exec_depend>ros_gz_sim</exec_depend>
</package>
'''


def _cmake(pkg: str) -> str:
    return f'''cmake_minimum_required(VERSION 3.8)
project({pkg})

find_package(ament_cmake REQUIRED)

# 仅分发 world / models / launch，无需编译目标。
install(DIRECTORY world models launch
        DESTINATION share/${{PROJECT_NAME}})

ament_package()
'''


def _readme(name: str, size_m: float, mesh_grid: int,
            visual_grid: int, tex_size: int,
            spawn: Dict[str, Any], waypoints: List[Dict[str, Any]],
            hm_max: float, dtm_max: float) -> str:
    return f"""# PlanetMission · Jezero 火星 Gazebo 仿真地图包

由 PlanetMission 平台从 Jezero 真实 HiRISE 地形（{size_m:.0f} m × {size_m:.0f} m）
自动导出。目标环境：**ROS 2 Jazzy + Gazebo Harmonic (gz-sim 8)**。

**本包只导地图**：不含任何巡视器模型、传感器、机械臂或驱动插件。
把你自己探测器的模型目录放入 `models/`（目录名 = model.config 的
`<name>`）即可被 Gazebo 加载，详见下文「生成你的车辆」。

## 目录结构
```
{name}/
├── README.md
├── export_meta.json            # 含推荐 spawn 点与坡度
├── world/{name}.world
├── launch/{name}.launch.py
└── models/
    └── {name}_terrain/         # 目录名 = model.config <name> = world model://
        ├── model.config
        ├── model.sdf           # collision=heightmap({mesh_grid}) / visual=mesh({visual_grid})+PBR
        ├── mars_height.png     # 16-bit 灰度高度图（碰撞，{mesh_grid}²）
        ├── terrain.obj         # 旧 {mesh_grid}² 视觉网格（保留作回退）
        ├── terrain_hi.obj      # 新 {visual_grid}² 视觉网格（带 UV）
        ├── mars_color.jpg      # {tex_size} albedo（JPG q90）
        └── mars_normal.jpg     # {tex_size} 法线（OpenGL +Y 约定）
```

## 视觉/碰撞分离

- **碰撞**：{mesh_grid}² heightmap（`mars_height.png`），物理稳定、
  仿真不减速，与平台训练环境同源，一行不改；
- **视觉**：{visual_grid}² 高密度网格 + {tex_size}² PBR 三件套
  （albedo / normal / metalness 0.05 + roughness 0.9），观感贴近
  three.js 参考。视觉网格升到 2049 亦可，但 headless 相机帧率会
  明显下降，按机器量力而行。

## 运行
```bash
# 方式一：ROS2 launch
ros2 launch {_package_name(name)} {name}.launch.py

# 方式二：直接启动（GZ_SIM_RESOURCE_PATH 必须指向 models/ 目录本身）
GZ_SIM_RESOURCE_PATH=$PWD/models gz sim -r world/{name}.world
```

## 生成你的车辆（不要假设地面在 z=0）
推荐 spawn 点（全区自动搜索的平坦补丁，详见 export_meta.json）：
- world_x = {spawn['world_x']} m, world_y = {spawn['world_y']} m
  （world_y 向南为正，北为 -y）
- ground_z = {spawn['ground_z']} m
- 补丁内最坏坡度 worst_case_slope_deg = {spawn['worst_case_slope_deg']}°
  （搜索 ≥{spawn['patch_size_m']:.0f} m × {spawn['patch_size_m']:.0f} m、
  坡度 <5° 的补丁{'：已满足' if spawn['meets_5deg'] else '：未找到，取全域最平坦处'}
  ，在源分辨率 3×3 像素梯度上评估）

```bash
# 车辆 spawn 在地形表面上方 0.4 m 处自由落下着陆
ros2 run ros_gz_sim create -file models/<你的车辆>/model.sdf \\
  -x {spawn['world_x']} -y {spawn['world_y']} -z {spawn['ground_z'] + 0.4:.3f}
```

## 参数
- 区域边长：{size_m:.0f} m；碰撞网格：{mesh_grid} × {mesh_grid}；视觉网格：{visual_grid} × {visual_grid}
- 贴图：albedo / normal 各 {tex_size}²（JPG q90，metalness 0.05 / roughness 0.9）
- heightmap：16-bit，最大像素 65535 ↔ size.z = {hm_max:.3f} m
  （导出网格实测最大相对高程；与源 DTM 高差 {dtm_max:.3f} m 的差值
  为降采样平滑标定误差，见 export_meta.json）
- 任务标记：{len(waypoints)} 个（由任务设计注入，导出时未编造）

## 规范要点（实测踩坑）
- world 显式声明 Physics / UserCommands / SceneBroadcaster 系统插件，
  缺失则无物理引擎、spawn 请求永远挂起且无报错。
- 重力 `<gravity>0 0 -3.71</gravity>`（-z 竖直向下）。
- 模型 URI 使用纯文件名（如 `mars_height.png`），禁止 `file://` 相对路径。
- visual 不用 heightmap（gz Harmonic 会生成 __default__ 法线贴图材质导致
  world 加载失败），改用高密度 OBJ（terrain_hi.obj）；collision 用 heightmap
  保证物理碰撞精确。
- PBR 必须 metal workflow + 显式 `<metalness>0.05</metalness>`：
  `<metal>` 下只给 albedo_map 时默认 metalness=1，无环境光可反射，
  渲染纯黑。`<diffuse>` 只接受颜色，填 URI 会使 model 解析失败。
- 法线图 `mars_normal.jpg` 用 OpenGL +Y 约定（绿色通道 = 纹理 v = 北）；
  符号写反会使凹地变山脊。
- 若你的 Gazebo 版本中碰撞与视觉地形出现南北镜像，将 terrain_hi.obj 的
  y 坐标取反（或垂直翻转 mars_height.png）即可对齐。
"""


# ---------------------------------------------------------------- 主入口


def export_gazebo(name: str, out_root: Optional[Path] = None,
                  mesh_grid: Optional[int] = None,
                  visual_mesh_grid: Optional[int] = None,
                  tex_size: Optional[int] = None,
                  tex_quality: Optional[int] = None,
                  normal_strength: Optional[float] = None,
                  fill_light: Optional[float] = None,
                  waypoints: Optional[List[Dict[str, Any]]] = None,
                  sdf_version: Optional[str] = None) -> Dict[str, Any]:
    """导出一个区域的 Gazebo/ROS2 仿真**地图包**，返回溯源与产物清单。

    本包只导地图：不含任何巡视器模型、传感器、机械臂或驱动插件
    （探测器的相机/雷达功能在平台侧实现，不进入 Gazebo 包）。
    用户把自己的模型目录放进 models/ 即可被 Gazebo 加载；推荐 spawn
    点（地形元数据）保留在 export_meta.json 与 README 中。

    任务标记（waypoints）不强制：waypoints=None（默认）不生成任何任务
    对象；等用户在平台上设计完任务后，把标记坐标传进来再导出。
    """
    cfg = dict(GAZEBO_DEFAULTS)
    if mesh_grid is not None:
        cfg["mesh_grid"] = int(mesh_grid)
    if visual_mesh_grid is not None:
        cfg["visual_mesh_grid"] = int(visual_mesh_grid)
    if tex_size is not None:
        cfg["tex_size"] = int(tex_size)
    if tex_quality is not None:
        cfg["tex_quality"] = int(tex_quality)
    if normal_strength is not None:
        cfg["normal_strength"] = float(normal_strength)
    if fill_light is not None:
        cfg["fill_light_intensity"] = float(fill_light)
    if sdf_version is not None:
        cfg["sdf_version"] = str(sdf_version)
    if waypoints is None:
        waypoints = []

    if cfg["mesh_grid"] < 2:
        raise GazeboExportError("mesh_grid 必须 >= 2")
    if cfg["visual_mesh_grid"] < 2:
        raise GazeboExportError("visual_mesh_grid 必须 >= 2")
    if out_root is None:
        out_root = GAZEBO_EXPORT_DIR / name

    out_root = Path(out_root)
    height, grid, meta = _load_height_field(name)
    size_m = float(meta["size_m"])
    max_h = float(np.nanmax(height))
    if max_h <= 0:
        raise GazeboExportError("区域相对高程全为 0，无法生成地形。")

    # 降采样到导出网格（碰撞高度图：物理行为与旧版完全一致）
    hm = raster_source.resample_to_grid(height, cfg["mesh_grid"])
    hm = np.nan_to_num(hm, nan=0.0)

    # 视觉网格独立取高分辨率高度场（与碰撞解耦）
    hm_vis = _load_visual_height(name, cfg["visual_mesh_grid"])

    # 要求 3：模型目录名必须与 model.config 的 <name> 完全一致——
    # gz 对 model://xxx 的查找按目录名匹配。
    terrain_dir = out_root / "models" / ("%s_terrain" % name)
    world_dir = out_root / "world"
    launch_dir = out_root / "launch"

    # 1) 地形资源（始终生成）
    terrain_dir.mkdir(parents=True, exist_ok=True)
    world_dir.mkdir(parents=True, exist_ok=True)
    launch_dir.mkdir(parents=True, exist_ok=True)
    hm_max = _export_heightmap(hm, terrain_dir)
    _export_color_texture(name, terrain_dir, cfg["tex_size"],
                          quality=cfg["tex_quality"])
    _export_normal_map(hm_vis, size_m, terrain_dir, cfg["tex_size"],
                       cfg["normal_strength"], quality=cfg["tex_quality"])
    _export_obj(hm, size_m, terrain_dir, filename="terrain.obj")
    _export_obj(hm_vis, size_m, terrain_dir, filename="terrain_hi.obj")
    _write_text(terrain_dir / "model.sdf",
                _terrain_model_sdf(f"{name}", size_m, hm_max,
                                   cfg["sdf_version"]))
    _write_text(terrain_dir / "model.config",
                _model_config(f"{name}_terrain", "model.sdf",
                              "Mars Jezero terrain (heightmap)"))

    # 要求 7：全区搜索推荐 spawn 点
    spawn = _find_spawn(height, size_m)
    print("  推荐 spawn 点 (%.1f, %.1f) 地面高程 %.2f m，补丁内最大坡度 %.2f°%s"
          % (spawn["world_x"], spawn["world_y"], spawn["ground_z"],
             spawn["worst_case_slope_deg"],
             "" if spawn["meets_5deg"] else "（未找到 <5° 补丁，取最平坦处）"))

    # 目录改名（要求 3）后清理历史版本残留的 models/terrain/，
    # 避免残留目录被 gz 扫描到（其 config 名与目录名不一致）。
    legacy_terrain = out_root / "models" / "terrain"
    if legacy_terrain.exists():
        import shutil
        shutil.rmtree(legacy_terrain)

    # 清理旧版 PNG 贴图残留（现已改用 JPG）
    legacy_png = terrain_dir / "mars_color.png"
    if legacy_png.exists():
        legacy_png.unlink()

    # 2) 任务标记：导出阶段不编造任务；仅当用户传进 waypoints 时才生成。
    for wp in waypoints:
        wp["z"] = float(_height_at(hm, size_m, float(wp["x"]), float(wp["y"])))

    # 3) 世界
    _write_text(world_dir / ("%s.world" % name),
                _world_sdf(name, waypoints, cfg["sdf_version"], spawn,
                           fill_light=cfg["fill_light_intensity"]))

    # 4) ROS2 包
    _write_text(launch_dir / ("%s.launch.py" % name),
                _launch_py(name))
    _write_text(out_root / "package.xml", _package_xml(_package_name(name)))
    _write_text(out_root / "CMakeLists.txt", _cmake(_package_name(name)))
    _write_text(out_root / "README.md",
                _readme(name, size_m, cfg["mesh_grid"],
                        cfg["visual_mesh_grid"], cfg["tex_size"],
                        spawn, waypoints, hm_max, max_h))

    # 6) 溯源元数据
    terrain_model_dir = "models/%s_terrain" % name
    export_meta = {
        "name": name,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "target": "ROS 2 Jazzy + Gazebo Harmonic (gz-sim 8)",
        "source_meta": meta,
        "params": cfg,
        "terrain": {
            "size_m": size_m,
            "mesh_grid": cfg["mesh_grid"],
            "visual_mesh_grid": cfg["visual_mesh_grid"],
            "max_height_m": round(max_h, 3),
        },
        # 要求 6：高度图标定来源与误差说明
        "heightmap": {
            "bit_depth": 16,
            "png_max_pixel": 65535,
            "size_z_m": round(hm_max, 3),
            "source": (
                "导出网格（%d²，含高斯平滑降采样）实测最大相对高程；"
                "与源 DTM 全图最大高差 %.3f m 的差值即标定误差来源"
                % (cfg["mesh_grid"], abs(max_h - hm_max))
            ),
        },
        # 要求 7：推荐 spawn 点
        "spawn": spawn,
        "waypoints": waypoints,
        "files": {
            "world": "world/%s.world" % name,
            "terrain_model": "%s/model.sdf" % terrain_model_dir,
            "terrain_heightmap": "%s/mars_height.png" % terrain_model_dir,
            "terrain_texture": "%s/mars_color.jpg" % terrain_model_dir,
            "terrain_normal_map": "%s/mars_normal.jpg" % terrain_model_dir,
            "terrain_mesh": "%s/terrain.obj" % terrain_model_dir,
            "terrain_visual_mesh": "%s/terrain_hi.obj" % terrain_model_dir,
            "launch": "launch/%s.launch.py" % name,
        },
    }
    _write_text(out_root / "export_meta.json",
                json.dumps(export_meta, ensure_ascii=False, indent=2))

    return {
        "name": name,
        "out_dir": str(out_root),
        "mesh_grid": cfg["mesh_grid"],
        "visual_mesh_grid": cfg["visual_mesh_grid"],
        "size_m": size_m,
        "max_height_m": round(max_h, 3),
        "spawn": spawn,
        "waypoints": waypoints,
        "files": export_meta["files"],
    }


def package_export(name: str, out_root: Optional[Path] = None,
                   fmt: str = "zip", dest: Optional[Path] = None) -> str:
    """把已导出的仿真包打成压缩包，返回压缩包路径。

    fmt="zip"  生成 zip；fmt="tar.gz" 生成 tar.gz。压缩包内含顶层目录
    <name>/，解压即可用。导出尚未执行时抛 GazeboExportError。
    """
    if fmt not in ("zip", "tar.gz"):
        raise GazeboExportError("不支持的打包格式：%s（zip / tar.gz）" % fmt)
    if out_root is None:
        out_root = GAZEBO_EXPORT_DIR / name
    out_root = Path(out_root)
    if not out_root.exists():
        raise GazeboExportError("尚未导出 Gazebo 包：%s" % out_root)

    if dest is None:
        dest = out_root.parent / ("%s_gazebo.%s" % (name, fmt))
    dest = Path(dest)

    if fmt == "zip":
        with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zf:
            for p in sorted(out_root.rglob("*")):
                if not p.is_file():
                    continue
                if p.name == "__pycache__" or p.suffix == ".pyc":
                    continue
                # arcname 相对 out_root 的父目录，保留 <name>/ 顶层前缀
                zf.write(p, arcname=str(p.relative_to(out_root.parent)))
    else:
        with tarfile.open(dest, "w:gz") as tf:
            tf.add(str(out_root), arcname=name)
    return str(dest)
