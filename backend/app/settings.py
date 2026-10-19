"""全局配置：路径、区域定义、地形分析参数、火星物理参数、图层定义。

所有可调参数集中于此，便于单测与后续阶段（IR / Gazebo 导出）复用。
数值口径依据 PlanetMission 策划书 V4 第 17、18、27、29 章。
"""

from pathlib import Path
from typing import Dict, List, Tuple

# ---------------------------------------------------------------- 路径

ROOT = Path(__file__).resolve().parents[2]

DATA_DIR = ROOT / "data"
REPO_DIR = ROOT / "dataset_repo"
BACKEND_DIR = ROOT / "backend"
FRONTEND_DIR = ROOT / "frontend"
FRONTEND_DIST = FRONTEND_DIR / "dist"
SHOTS_DIR = ROOT / "shots"

REGIONS_DIR = REPO_DIR / "regions"
REGIONS_INDEX = REPO_DIR / "regions_index.json"

# 任务定义目录（第 19 章 Mission JSON Schema）。
# 每个区域一个子目录：missions/<region>/<mission_id>.json
MISSIONS_DIR = REPO_DIR / "missions"

# Gazebo / ROS2 导出包根目录。每个区域导出一个独立子目录，
# 内含可直接 `gz sim` 打开的世界文件和 ROS2 launch。
GAZEBO_EXPORT_DIR = REPO_DIR / "gazebo"

# Gazebo 地形导出的默认参数（V4 第 19 章：仿真场景生成）。
# mesh_grid：碰撞高度图网格分辨率。物理稳定优先，257 在笔记本上
#   既不拖慢物理步进也保留地形大势——视觉细节由 visual_mesh_grid
#   的网格与贴图承担，两者分离（视觉/碰撞解耦）。
# visual_mesh_grid：视觉网格（terrain_hi.obj）分辨率。1025² 约
#   200 万三角面，headless 相机渲染可接受；4096 起步会掉到个位数
#   帧率，不要默认调大。
# tex_size：贴图分辨率（albedo/normal 同尺寸，JPG 存储）。
# tex_quality：JPG 质量（4096 PNG 20–50 MB，gz 解码慢，故用 JPG）。
# normal_strength：法线图梯度缩放。55 m/2000 m 尺度下 2–5 自然。
# fill_light_intensity：太阳反方向补光强度（贴近参考图氛围）。
GAZEBO_DEFAULTS: Dict[str, object] = {
    "mesh_grid": 257,
    "visual_mesh_grid": 1025,
    "tex_size": 4096,
    "tex_quality": 90,
    "normal_strength": 3.0,
    "fill_light_intensity": 0.2,
    "sdf_version": "1.10",
    # 完整 ROS2/Gazebo 包名由 pipeline/gazebo_export.py 按区域名派生
    # （<region_name> + 此后缀），区域配置可用 "gazebo_package" 显式覆盖
    # 以保持历史包名。早期版本在此处全局写死 "jezero_gazebo"，多区域
    # 导出会互相撞名，导致 CMake project() 冲突与 ros2 launch 指错包。
    "package_suffix": "_gazebo",
}

# 原始数据文件名（NASA PDS / USGS 公开数据，不随软件分发）
DTM_FILENAME = (
    "JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_"
    "1m_Eqc_latTs0_lon0_blend40.tif"
)
ORTHO_FILENAME = "JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first.tif"
GLOBE_FILENAME = "Mars.tif"

# HiRISE 单景 DTM（Athabasca Valles 火山喷口）。格式为 ISIS/PDS 的 .img
# 与 JP2 正射，而非 GeoTIFF；投影为局部等距圆柱
# （lon_0=157.34、lat_ts=5、R=3396036.81），与 Jezero 拼接影像不同，
# 由 core/coords.py 从栅格 CRS 实测读取，勿按文件名推断。
ATHABASCA_DTM_FILENAME = "DTEEC_010414_1900_010269_1900_A01.img"
ATHABASCA_ORTHO_FILENAME = "PSP_010414_1900_RED_A_01_ORTHO.jp2"


def resolve_data(filename: str) -> Path:
    """定位原始数据文件。

    依次在 data/ 与项目根目录查找，允许数据文件放在任一处而不必修改代码。
    全部缺失时返回首选路径，由调用方给出明确报错。
    """
    for base in (DATA_DIR, ROOT):
        candidate = base / filename
        if candidate.exists():
            return candidate
    return DATA_DIR / filename


DTM_FILE = resolve_data(DTM_FILENAME)
ORTHO_FILE = resolve_data(ORTHO_FILENAME)
GLOBE_FILE = resolve_data(GLOBE_FILENAME)
ATHABASCA_DTM_FILE = resolve_data(ATHABASCA_DTM_FILENAME)
ATHABASCA_ORTHO_FILE = resolve_data(ATHABASCA_ORTHO_FILENAME)

# ---------------------------------------------------------------- 区域定义

# Jezero 陨石坑着陆区。
# landing_site 为语义锚点（真实着陆点坐标，保留在元数据中）；
# center 为实际裁剪中心。由 backend/tools/scan_footprint.py 以 2 km 窗口
# 扫描 ortho 后选取：54/100 个候选块完全无缺失，最近者距着陆点 1216 m。
# 中心比锚点略偏东北，仍在 Jezero 陨石坑内。
JEZERO_REGION: Dict[str, object] = {
    "name": "jezero_landing_site",
    "body": "mars",
    "landing_site": {"lon": 77.4298, "lat": 18.4663},
    "center": {"lon": 77.4423, "lat": 18.45},
    "size_m": 2000,
    "resolution_m": 1.0,
    "grid": 1025,
    "grids": {"interactive": 1025, "capture": 2049},
    "textures": {"interactive": 2048, "capture": 4096},
    "source": (
        "Mars 2020 TRN HiRISE DTM Mosaic (SOC 006) + orthomosaic, "
        "MOLA topography / DeltaGeoid blend"
    ),
    "license": "NASA PDS / USGS Astrogeology",
    "license_note": (
        "Derived from NASA Planetary Data System (PDS) and USGS Astrogeology "
        "Science Center"
    ),
    "crs": "ESRI:103885",
    "resolution_source": "hires_trn_dtm",
    # 显式保留历史包名：派生规则会得到 jezero_landingsite_gazebo，
    # 而既有导出包与 README 均以 jezero_gazebo 为准。
    "gazebo_package": "jezero_gazebo",
    "min_ortho_zero_ratio": 0.05,
    # 程序化岩石场（core/rocks.py）：源 DTM 地表过于平滑，按真实
    # Jezero 碎石丰度补一层岩块。seed 固定保证可复现；改密度只需
    # 调 count。高度场 bump 与语义/通行覆写、贴图、前端 3D 实例
    # 三者同源。
    # 分布策略：坡度加权（越平越密）+ 成簇撒点（碎石场），尺寸
    # 以碎石为主（0.08–1.0 m，含中砾），3D 网格下沉 0.35h 嵌入地表。
    "rocks": {
        "enabled": True,
        "count": 5000,
        "seed": 20261015,
        "r_min_m": 0.08,
        "r_max_m": 1.0,
        "h_factor": 0.6,
        "slope_full_deg": 10.0,
        "cluster_prob": 0.35,
        "cluster_radius_m": 12.0,
        "min_gap_m": 0.15,
        "edge_margin_m": 3.0,
        "power_k": 2.0,
    },
    # 地表细节增强（core/detail.py）：源 DTM 经平滑与降采样后表面
    # 过于光滑，分三路补细节——
    #   fbm_relief：指标计算前向高度场注入分形微起伏（结构化噪声，
    #     波长 ≥4 m 防混叠），坡度/粗糙度/曲率/TI/法线全部随之变糙；
    #   detail_normal：法线贴图叠加程序化高频细节（沙波纹/砾石感）；
    #   roughness_map：空间变化的粗糙度贴图，光照不再一片均匀；
    #   unsharp：正射灰度高通增强，恢复被重采样低通削掉的反差。
    "detail": {
        "fbm_enabled": True,
        "fbm_seed": 77123,
        # [波长 m, 幅度 m]：幅度即该 octave 高程标准差
        "fbm_octaves_m": [[8.0, 0.10], [4.0, 0.04]],
        # 法线细节：默认关闭（用户实测反馈噪声感重）。需要时把
        # normal_detail_slope_deg 调到 4–10 再启用；波长 ≥4 m 是
        # 两档纹理不混叠的下限，调细前先看这条
        "normal_detail_slope_deg": 0.0,
        "normal_octaves_m": [[8.0, 1.0], [4.0, 0.5]],
        # 粗糙度图：基础值 ± 变化量，另随坡度上浮（陡处多砾石）
        "roughness_base": 0.92,
        "roughness_variation": 0.14,
        "roughness_octaves_m": [[8.0, 1.0], [4.0, 0.5]],
        # 正射锐化：量与高斯半径（单位为纹理像元，约 1 m）。
        # 只提振 4–5 m 以上的中频反差；过细则起噪点
        "unsharp_amount": 0.35,
        "unsharp_sigma_px": 2.5,
    },
}

# Athabasca Valles 火山喷口（HiRISE 单景 DTM，9.63N 157.3E）。
# 选址依据：Elysium 火山省的东西向断裂谷，切割出断层崖与熔岩流，
# 坡度层次比 Jezero 三角洲（坡度中位 2.8°）和 Cerberus Tholi 峰顶
# （盾状火山顶近于平坦）都更丰富，可通行性图层才有层次可辨。
#
# 与 Jezero 的三点差异：
# 1. 源格式为 ISIS/PDS 的 .img + JP2，而非 GeoTIFF；投影为局部等距圆柱
#    （lon_0=157.34、lat_ts=5、R=3396036.81），由 core/coords.py 读取。
# 2. 源像元实测 1.0113 m/px（非整米）。resolution_m 仅作元数据声明，
#    实际边长与量纲一律以栅格 transform 实测值为准。
# 3. 本区域无真实着陆点，landing_site 仅为语义锚点，取该 DTM 中心。
ATHABASCA_REGION: Dict[str, object] = {
    "name": "athabasca_valles_vent",
    "body": "mars",
    "landing_site": {"lon": 157.3, "lat": 9.63},
    # 由 tools/scan_footprint.py 在 DTM 上求得：先要求缺失率 ≤1%，再在
    # 达标窗口中优先取「几乎无缺失」且起伏最大者（块级粗筛+ 精确复核两阶段）。
    # 该 DTM 覆盖 6.9x13.0 km、全图缺失 24.7%；默认的 DTM 中心落在无效区
    # 边缘（缺失 10.9%、起伏仅 10.6 m）。本处缺失 0.009%、起伏 68.54 m，
    # 起伏远大于 Jezero 的 36.7 m，坡度层次更足。
    "center": {"lon": 157.3682, "lat": 9.5733},
    "size_m": 2000,
    "resolution_m": 1.0113,
    "grids": {"interactive": 1025, "capture": 2049},
    "textures": {"interactive": 2048, "capture": 4096},
    "dtm_file": ATHABASCA_DTM_FILE,
    "ortho_file": ATHABASCA_ORTHO_FILE,
    "source": (
        "MRO HiRISE single-scene DTM "
        "(DTEEC_010414_1900_010269_1900_A01, 1.01 m/px) "
        "+ RED_A orthoimage (0.25 m/px)"
    ),
    "license": "NASA/JPL-Caltech/UArizona",
    "license_note": (
        "HiRISE DTM 由 University of Arizona HiRISE Operations Center 生成，"
        "原始数据存档于 NASA Planetary Data System"
    ),
    "crs": (
        "Equirectangular (proj=eqc, lat_ts=5, lon_0=157.34, "
        "R=3396036.81)"
    ),
    "resolution_source": "hirise_dtm_single_scene",
    "min_ortho_zero_ratio": 0.05,
    # 断裂谷地貌的大尺度起伏来自真实 DTM，不需要沙脊那样的强补偿；
    # fbm 幅度取得比 Jezero 小，保留给熔岩表面缺失的细纹理。
    "detail": {
        "fbm_enabled": True,
        "fbm_seed": 77123,
        "fbm_octaves_m": [[8.0, 0.08], [4.0, 0.03]],
        "normal_detail_slope_deg": 0.0,
        "normal_octaves_m": [[8.0, 1.0], [4.0, 0.5]],
        "roughness_base": 0.92,
        "roughness_variation": 0.14,
        "roughness_octaves_m": [[8.0, 1.0], [4.0, 0.5]],
        "unsharp_amount": 0.35,
        "unsharp_sigma_px": 2.5,
    },
    # 熔岩表面天然比风成沙地光洁，崩塌堆积集中在断层崖下；
    # 碎石数量先取低于 Jezero 的值，跑通后按 env_stats 的
    # rock_cover_pct 再标定。
    "rocks": {
        "enabled": True,
        "count": 3200,
        "seed": 20261015,
        "r_min_m": 0.08,
        "r_max_m": 1.0,
        "h_factor": 0.6,
        "slope_full_deg": 10.0,
        "cluster_prob": 0.35,
        "cluster_radius_m": 12.0,
        "min_gap_m": 0.15,
        "edge_margin_m": 3.0,
        "power_k": 2.0,
    },
}

REGIONS: List[Dict[str, object]] = [JEZERO_REGION, ATHABASCA_REGION]


def region_dir(name: str) -> Path:
    return REGIONS_DIR / name


# ---------------------------------------------------------------- 地形分析

# 可通行性指数权重（V4 17.1）
TI_W_SLOPE = 0.40
TI_W_ROUGH = 0.20
TI_W_SEMANTIC = 0.30
TI_W_CURV = 0.10

# 归一化上限。V4 17.1 原稿用坡度 30°、粗糙度 2 m，实测会导致 TI 全部
# 落在 0.9 以上而失去区分度（1 km 区域实测坡度中位数仅 2.2°、粗糙度中位数
# 0.011 m，远小于原尺度）。此处按巡视器实际能力标定：坡度以安全爬坡上限
# 15° 为满分基准，粗糙度以松散碎石 0.30 m 为满分基准。
SLOPE_SCALE_DEG = 15.0
ROUGH_SCALE_M = 0.30
CURV_SCALE = 0.03  # 1/m

# 三阈值与不确定带（V4 17.2）
TI_PASS = 0.70
TI_SLOW = 0.40
# 不确定带半宽。V4 原稿取 0.05，但实测该区域 TI 的四分位距仅约 0.09，
# 0.05 的带宽会吞掉 15% 的区域，使不确定带失去「标记少量可疑区域」的意义。
# 平滑后坡度噪声对 TI 的贡献约 0.4 × 0.3°/15° ≈ 0.008，取 0.03 已可覆盖。
TI_BAND = 0.03

# 计算坡度前的高斯平滑标准差（米）。1 m/px DTM 垂直噪声达数十厘米，
# 不平滑会得到满屏噪点，进而使可通行性判定失效（V4 16.3）。
SMOOTH_SIGMA_M = 1.0

# 法线贴图斜率放大倍数。**必须为 1.0（物理一致）**：法线图表达的光照
# 斜率若大于网格几何实际坡度，低太阳角下背光假陡坎全黑，地表出现
# 黑色斑纹（实测 slope×2.5 → 满屏暗纹）。沙脊波纹的可辨性由真实
# 地形法线自然呈现，不靠放大；超过 1 即与几何脱节。
NORMAL_STRENGTH = 1.0

ROUGH_WINDOW = 3  # 粗糙度 3x3 邻域

# ---------------------------------------------------------------- 图层定义

# 语义分类配色与通行分、摩擦系数（V4 17.3）
SEMANTIC_CLASSES: Dict[str, Dict[str, object]] = {
    "sand": {"label": "沙地", "color": "#C9A227", "score": 0.75, "friction": 0.45},
    "bedrock": {"label": "裸岩", "color": "#8D7B6B", "score": 0.70, "friction": 0.60},
    "boulder": {"label": "巨石", "color": "#5C4A3D", "score": 0.10, "friction": 0.75},
    "base": {"label": "基站", "color": "#34C759", "score": 1.0, "friction": 0.60},
}
SEMANTIC_ORDER: List[str] = ["sand", "bedrock", "boulder", "base"]

# 可通行性配色（V4 17.2 与界面配色规范一致）
TI_COLORS = {
    "pass": "#34C759",
    "slow": "#FFD60A",
    "forbidden": "#FF3B30",
    "band": "#8D7B6B",
}

# 图层清单。顺序即渲染层级：靠前者为底层，靠后者为顶层。
# 原始影像置于最底层，语义分类置于最上层，因此面板中自下而上
# 勾选时，后勾选的分析图层会覆盖先勾选者。
LAYER_DEFS: List[Dict[str, object]] = [
    {"id": "color", "name": "原始影像", "swatch": "#8D7B6B", "color_space": "srgb"},
    {"id": "hillshade", "name": "地形晕渲", "swatch": "#A89880", "color_space": "srgb"},
    {"id": "slope", "name": "坡度", "swatch": "#FF8C42", "color_space": "none"},
    {"id": "curvature", "name": "曲率", "swatch": "#4A9EFF", "color_space": "none"},
    {"id": "roughness", "name": "粗糙度", "swatch": "#C0A080", "color_space": "none"},
    {"id": "traversability", "name": "可通行性", "swatch": "#34C759",
     "color_space": "none"},
    {"id": "semantic", "name": "语义分类", "swatch": "#C9A227", "color_space": "none"},
]
LAYER_IDS: List[str] = [str(item["id"]) for item in LAYER_DEFS]

# ---------------------------------------------------------------- 火星物理

MARS_RADIUS_M = 3396190.0
SOL_SECONDS = 24.6597 * 3600.0
MARS_AXIAL_TILT_DEG = 25.2

GRAVITY_MS2 = 3.71
AIR_DENSITY_KG_M3 = 0.020
FRICTION_BASE = 0.55
DUST_TAU_RANGE = (0.3, 1.5)

# ---------------------------------------------------------------- 训练环境
# （策划书第 20 章：Surrogate 巡视器参数）
#
# 重要说明——时间与速度尺度：本环境为训练用 surrogate，控制频率 10 Hz、
# 线速度上限 1.0 m/s，远高于 TurtleBot3 waffle 的 0.26 m/s 实车极速。
# 这是有意的工程取舍：surrogate 的用途是批量采集训练数据与验证任务
# 结构，实车级速度会让一个 episode 长达数小时，与 Gazebo 验证时使用
# 的指令尺度一致（评审用视觉验证不受影响）。所有参数均可溯源，
# 结论须经 20.6 节 Gazebo 对比验证后方可引用。

ENV_PARAMS: Dict[str, object] = {
    "dt": 0.1,                    # 控制步长（秒），10 Hz
    "v_max": 1.0,                 # 线速度上限（m/s，surrogate 尺度）
    "w_max": 1.0,                 # 角速度上限（rad/s）
    "rover_radius": 0.28,         # 车体半径（m，TurtleBot3 waffle 级别）
    "eye_height": 0.5,            # 虚拟激光发射高度（m）
    "tipover_slope_deg": 35.0,    # 横坡超过此值判定倾覆终止
    "rover_climb_slope_deg": 25.0,  # 硬件爬坡能力上限：超过才拒绝执行。
                                   # 任务 budget.max_slope_deg 仅作违规
                                   # 报告阈值，不再卡指令（实测反馈：
                                   # 「性能太弱」——原 15° 即拒指令）
    "stuck_time_s": 3.0,          # 持续指令速度但无进度的判定时长
    "idle_power_w": 5.0,          # 待机功率（W）
    "drive_power_w": 20.0,        # 行驶基准功率（W）
    "lidar_rays": 32,             # 虚拟激光线数（前向 180° 扇区）
    "lidar_range_m": 12.0,        # 量程（m）
    "lidar_step_m": 0.2,          # 射线步进（m）
    "lidar_noise_m": 0.05,        # 测距噪声标准差（m）
    # 各地面类别的基础滑转率（车-地力学常规量级）。沙地值经实测反馈
    # 两轮下调：原 sand 0.15 在 5–10° 坡上即频繁触发滑转事件与轮子空转，
    # 体感「非常容易打滑」；保留沙地/基岩的相对差异（bedrock 0.03）。
    "slip_base": {"unknown": 0.05, "sand": 0.06, "bedrock": 0.03,
                  "boulder": 0.15, "base": 0.03},
    "slip_slope_gain": 0.15,      # 每 10° 坡度的滑转率放大系数（爬坡打滑体感）
    "slip_event_ratio": 0.20,     # 滑转率超过此值记一次滑转事件（常规地形
                                  # ≤0.195 不再触发；RECOVERY 故障区 3×
                                  # 倍数 0.21+ 仍会，保持脱困挑战）
    "collision_dedup_s": 1.0,     # 碰撞事件按时间窗口去重（V4 19.3）
    # ---- 碎石 vs 岩体：语义栅格一格 1.95 m，是车体（0.56 m）的 3.5倍，
    # 一律当实心墙会让视觉上几十厘米高的碎石也拦路（实测 0.197 m 隆起
    # 的碎石把车堵在原地 190 s；实测全区 92.8% 巨石格隆起 < 0.5 m）。
    # 改为按 DEM 局部隆起分级：≥ 阈值的才算岩体（必须绕行），低于阈值
    # 的按碎石处理——直接碾过，只付出速度与滑转代价。
    "boulder_block_h": 0.5,       # 判定为「岩体」的最小隆起（米）
    "boulder_bump_slip": 0.12,    # 碾过碎石（隆起达阈值）额外滑转率
    "boulder_bump_slow": 0.20,    # 碾过碎石的速度损失比例
    "hold_time_s": 2.0,           # 到位保持时长
    "tol_yaw_deg": 30.0,          # 到位朝向容差
    "survey_radius_m": 15.0,      # 勘测成像覆盖半径
    "traj_decimate_s": 0.5,       # 轨迹记录降采样间隔（秒）
    # ---- 顶点拍照（SURVEY_PATH）：火星车相机在三角形顶点朝质点成像 ----
    "photo_tol_m": 2.0,           # 顶点拍照位置容差（米）
    "photo_yaw_tol_deg": 8.0,     # 拍照朝向容差：光轴对准质心 ±8°（此前
                                  # 复用 tol_yaw 30°，车未转正即成像）
    "photo_hold_s": 0.6,          # 对准后停车保持时长（秒），边转边拍不计时
    "camera_height_m": 0.6,       # 相机安装高度（米，与巡视器桅杆相机一致）
    # ---- 雷达成像（TARGETED_APPROACH）：到位后斜向下扫视 10 m 半径地形 ----
    # 几何说明：雷达架在 2.5 m 桅杆顶，按环扫描——半径 r 的环用
    # 俯角 atan(H/r) 的波束（平坦地面恰好落在 r 处），标称俯角 35° 即
    # r ≈ 3.6 m 的主束。单束 35° 从 0.6 m 车高只能覆盖约 1 m，要覆盖
    # 10 m 半径必须抬高安装点并按环调俯角；近场 1.5 m 盲区由几何决定。
    # 流程：到位保持 → 起旋（车体旋转 spinup_s 秒）→ 边转边扫满 360°
    # 一圈即完成（coverage_target 仅作报告指标，不作终止条件）。
    "radar_range_m": 13.0,        # 雷达量程（米，>10/cos14° 的斜距需求）
    "radar_height_m": 2.5,        # 雷达安装高度（米，桅杆顶）
    "radar_pitch_deg": 35.0,      # 标称俯角（度，主束；对应 r≈3.6 m 环）
    "radar_ring_m": 0.25,         # 径向环采样间隔（米）
    "radar_blind_m": 1.5,         # 近场盲区半径（米）
    "radar_rays": 240,            # 每圈方位射线数（1.5°，10 m 处弧距 0.26 m）
    "radar_sweep_s": 20.0,        # 扫描一圈用时（秒，车体同步旋转角速度）
    "radar_spinup_s": 3.0,        # 起旋时长（秒，车先转起来再开始扫描）
    "radar_step_m": 0.2,          # 射线步进（米）
    "radar_noise_m": 0.05,        # 测距噪声标准差（米）
    "radar_grid_m": 0.5,          # 地形栅格分辨率（米，±10 m → 41×41）
    "radar_map_radius_m": 10.0,   # 地形图半径（米，以火星车为原点）
    "radar_coverage_target": 0.80,  # 覆盖率报告阈值（不作终止条件）
    "radar_max_sweeps": 3,        # 兜底最大圈数（防一圈未 wrap 的卡死）
}

# ---------------------------------------------------------------- 影像处理

# 正射影像灰度拉伸的分位数裁剪范围（V4 决策八）
ORTHO_STRETCH_LO = 2.0
ORTHO_STRETCH_HI = 98.0

# ortho 视为 nodata 的零值判据
ORTHO_NODATA_VALUE = 0

# ---------------------------------------------------------------- 球体视图

# Mars.tif 经度约定为标准 -180~+180（实测：南纬 20~0 度带最暗斑反推 70.2°E，
# 与 Syrtis Major 实际位置吻合）。
GLOBE_LON_CONVENTION = "-180_180"

# 球体在屏幕上的直径控制区间（像素）。1440x720 贴图在 500px 直径下
# 已超过屏幕需求，再放大反而模糊，故限制相机距离使球体不超过 ~560px。
GLOBE_SCREEN_DIAMETER_PX = 500
GLOBE_SCREEN_DIAMETER_MAX_PX = 560

# ---------------------------------------------------------------- 渲染档位

QUALITY_TIERS: Dict[str, Dict[str, object]] = {
    "interactive": {
        "label": "交互",
        "grid": 1025,
        "texture": 2048,
        "dust": 1400,
        "shadow_map": 1024,
        "postprocess": False,
        "pixel_ratio_cap": 1.5,
    },
    "capture": {
        "label": "出图",
        "grid": 2049,
        "texture": 4096,
        "dust": 5000,
        "shadow_map": 2048,
        "postprocess": True,
        "pixel_ratio_cap": 2.0,
    },
}

# 阴影相机跟随范围（米）。覆盖整个 1 km 区域时 2048 阴影图仅 0.5 m/纹素，
# 阴影严重模糊；限定 200 m 后约 0.1 m/纹素，边缘锐利。
SHADOW_FOLLOW_EXTENT_M = 200.0

# ---------------------------------------------------------------- 服务

API_HOST = "127.0.0.1"
API_PORT = 8000


def region_center_latlon(name: str) -> Tuple[float, float]:
    """返回区域实际裁剪中心的 (lat, lon)，单位度。"""
    for item in REGIONS:
        if item["name"] == name:
            center = item["center"]
            return float(center["lat"]), float(center["lon"])  # type: ignore[index]
    raise KeyError("未注册的区域: %s" % name)