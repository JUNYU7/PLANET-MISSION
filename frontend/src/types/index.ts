export type LayerId =
  | 'color'
  | 'hillshade'
  | 'slope'
  | 'curvature'
  | 'roughness'
  | 'traversability'
  | 'semantic'

export type ColorSpace = 'srgb' | 'none'
export type QualityTier = 'interactive' | 'capture'
export type ViewMode = 'globe' | 'region'

export interface LayerDef {
  id: LayerId
  name: string
  swatch: string
  color_space: ColorSpace
  file: string | null
  grid: number
}

export interface Manifest {
  tier: QualityTier
  grid: number
  texture: number
  size_m: number
  height_file: string
  /** 细节法线贴图文件名（旧区域为 null，前端跳过 normalMap） */
  normal_file: string | null
  /** 法线图梯度缩放（数据处理时强度；前端 normalScale = 1/strength） */
  normal_strength?: number
  layers: LayerDef[]
}

export interface RegionMeta {
  name: string
  body: string
  landing_site: { lon: number; lat: number }
  center: { lon: number; lat: number }
  size_m: number
  resolution_m: number
  crs: string
  source: string
  license: string
  license_note: string
  resolution_source: string
  elevation_absolute_range: [number, number]
  height_range: [number, number]
  grids: Record<string, number>
  textures: Record<string, number>
  generated_at: string
}

export interface EnvStats {
  pass_ratio: number
  slow_ratio: number
  forbidden_ratio: number
  band_ratio: number
  grid: number
  mean_slope_deg: number
  median_slope_deg: number
  max_slope_deg: number
  mean_roughness_m: number
  p95_slope_deg: number
  cells_over_15deg_pct: number
  ti_median: number
}

export interface RegionDetail {
  meta: RegionMeta
  stats: EnvStats
  manifest: Record<QualityTier, Manifest>
  thresholds: { pass: number; slow: number; band: number }
  traversability_colors: Record<string, string>
  semantic_classes: Record<
    string,
    { label: string; color: string; score: number; friction: number }
  >
}

/** 源影像实际覆盖范围，用于在球体上圈出真实footprint */
export interface Footprint {
  lon_min: number
  lon_max: number
  lat_min: number
  lat_max: number
  width_m: number
  height_m: number
}

export interface RegionSummary {
  name: string
  center: { lon: number; lat: number }
  landing_site: { lon: number; lat: number }
  /** 源影像覆盖范围，缺失时回退到着陆点标记 */
  footprint: Footprint | null

  size_m: number
  height_range: [number, number]
}

export interface GlobeMeta {
  texture_width: number
  texture_height: number
  screen_diameter_px: number
  lon_convention: string
  note: string
}

/** 高程场。data 为相对高程，row0 对应北侧边缘。 */
export interface HeightField {
  data: Float32Array
  /** 网格边长，513 或 1025 */
  n: number
  /** 场景边长（米） */
  size: number
}

/** 地形查询返回（第 21 章）。x 东、y 南、z 相对高程。 */
export interface TerrainQuery {
  z: number
  ti_class: number
  ti_name: 'band' | 'pass' | 'slow' | 'forbidden'
  slope_deg: number
  semantic: string
  roughness_m: number
}

/** 当前版本实现的任务类型（第 19.2 节前四类，编辑器开放前三类） */
export type ActivityType = 'TRAVERSE' | 'TARGETED_APPROACH' | 'SURVEY_PATH'

export interface MissionTarget {
  x: number
  y: number
  z: number
  tol_pos_m?: number
  /** 点的角色：目标点 / 朝向点 / 勘测顶点 / 勘测质心 */
  role?: 'target' | 'orientation' | 'vertex' | 'centroid'
  terrain_query?: {
    ti_class: number
    slope_deg: number
    semantic: string
    roughness_m: number
  }
}

export interface MissionActivity {
  id: string
  type: ActivityType
  targets: MissionTarget[]
  budget?: { time_s?: number; max_slope_deg?: number }
  success?: string
  /** SURVEY_PATH：顶点朝质心成像的相机视场角（度） */
  fov?: number
}

export interface MissionSol {
  sol: number
  power_budget_wh?: number
  comm_window?: string
  activities: MissionActivity[]
}

export interface Mission {
  mission_id: string
  region: string
  name?: string
  sol_hours?: number
  sols: MissionSol[]
  success_criteria?: string
  scoring?: string
}

export interface MissionSummary {
  mission_id: string
  name: string
  activities: number
}

/** 实时仿真帧（SSE data 事件） */
export interface LiveFrame {
  t: number
  x: number
  y: number
  yaw: number
  /** 指令线速度 / 角速度（m/s、rad/s） */
  v: number
  w: number
  /** 实际前进速度（指令速度 × (1-滑转)，轮子驱动用，消除打滑空转视觉） */
  v_actual?: number
  slip: number
  energy_wh: number
  slope_deg: number
  ti: string
  semantic: string
  height: number
  dust_tau: number
  local_hour: number
  /** 前向 180° 雷达扫描（归一化距离 0–1），供仪表面板可视化 */
  lidar: number[]
  /** 雷达量程（m） */
  lidar_range: number
  /** 姿态（前端由高程场差分求得，随帧附加）：俯仰 / 横滚（rad） */
  pitch?: number
  roll?: number
  /** 地形法线（世界坐标，已归一化），供三维陀螺仪定向 */
  normal?: { x: number; y: number; z: number }
  /** SURVEY_PATH：已拍顶点照片数（共 3） */
  photos?: number
  /** SURVEY_PATH：本帧新拍照片（含相机位姿，前端据此离屏渲染照片） */
  photo_events?: PhotoEvent[]
  /** TARGETED_APPROACH：雷达成像进度与本帧新增点云（相对火星车） */
  radar?: {
    /** spinup=起旋中 / scan=扫描中 / done=已完成 */
    phase: 'spinup' | 'scan' | 'done'
    coverage: number
    sweep: number
    angle: number
    points: [number, number, number][]
  }
  progress: {
    label: string
    ratio: number | null
    dist_to_goal_m: number | null
  }
  events: Array<{ t: number; type: string }>
}

/** 地形探针读数（游标悬停采样，经 /terrain/query 接口） */
export interface TerrainProbe {
  x: number
  y: number
  z: number
  slope_deg: number
  ti: string
  semantic: string
  roughness_m: number
}

/** 实时仿真结束负载（SSE done 事件） */
export interface LiveDone {
  metrics: {
    type: string
    success: boolean
    terminated_reason: string
    time_s: number
    path_len_m: number
    spl: number | null
    energy_wh: number
    collisions: number
    slip_events: number
    coverage: number | null
    photos_taken?: number | null
    scan_coverage?: number | null
    scan_points?: number | null
    scan_sweeps?: number | null
  }
  trajectory_file: string
}

/** SURVEY_PATH 顶点拍照事件（后端判定成功时推送相机位姿） */
export interface PhotoEvent {
  /** 顶点序号（0/1/2） */
  vertex: number
  /** 拍照时刻（仿真秒） */
  t: number
  /** 相机位置（世界坐标：x 东, y 南） */
  x: number
  y: number
  /** 相机朝向（rad，世界系，光轴指向质心） */
  yaw: number
  /** 质心目标（世界坐标） */
  target_x: number
  target_y: number
  /** 相机视场角（度，来自任务 fov） */
  fov: number
}

/** 前端离屏渲染生成的照片（PhotoEvent + dataURL） */
export interface CapturedPhoto extends PhotoEvent {
  /** PNG dataURL（火星车相机视角离屏渲染一帧） */
  url: string
}