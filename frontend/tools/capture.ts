/**
 * 出图机位预设与截图入口。
 *
 * 在应用中注册 window.__capture(viewName)，由浏览器自动化调用并把
 * dataURL 保存为文件。这样出图流程可重复、可批量、可纳入版本管理，
 * 且不依赖手工截屏的偶然性。
 *
 * 用法（浏览器自动化）：
 *   await page.evaluate("window.__capture('ground')")
 */

export type CaptureView =
  | 'overview'
  | 'ground'
  | 'oblique'
  | 'ti_top'

export interface ViewPreset {
  /** 相机位置（比例于场景边长）。Y 为 null 时按该点实际地形高度推算 */
  position: [number, number | null, number]
  /** 观察目标（比例于场景边长）。Y 为 null 时同样按地形高度推算 */
  target: [number, number | null, number]
  /** 视场角 */
  fov: number
  /** 相机高出该点地面的米数，仅 position[1] 为 null 时生效 */
  eyeOffset?: number
  /** 观察点高出该点地面的米数 */
  targetEyeOffset?: number
  /** 预设图层 */
  layer: string
  label: string
}

export const VIEW_PRESETS: Record<CaptureView, ViewPreset> = {
  overview: {
    position: [0.30, 0.34, 0.40],
    target: [-0.02, 0.02, -0.02],
    fov: 48,
    layer: 'color',
    label: '全景视角：区域全貌与陨石坑群分布',
  },
  ground: {
    // 视场收至 52°：72° 广角会让地平线弯曲、天空占比过半，
    // 边缘产生明显畸变，失去「巡视器视角」的现场感。
    position: [0.06, null, 0.10],
    target: [-0.16, null, -0.20],
    fov: 52,
    layer: 'color',
    label: '贴地第一视角：纹理细节与地平线',
    // 相机高出该点地面的米数，约等于巡视器桅杆高度
    eyeOffset: 2.6,
    // 观察点略低于相机，形成轻微俯视，便于看到近处地表
    targetEyeOffset: 0.4,
  },
  oblique: {
    position: [-0.32, 0.26, -0.28],
    target: [0.02, 0.0, 0.04],
    fov: 46,
    layer: 'hillshade',
    label: '45度斜俯视：地形起伏与晕渲',
  },
  ti_top: {
    position: [0.001, 0.55, 0.07],
    target: [0, 0, 0],
    fov: 46,
    layer: 'traversability',
    label: '正交顶视：可通行性判定结果',
  },
}

declare global {
  interface Window {
    __capture?: (view: CaptureView) => Promise<string | null>
    __captureViews?: () => CaptureView[]
  }
}

/** 在应用中注册截图入口，供浏览器自动化调用。 */
export function installCapture(
  capture: (view: CaptureView) => Promise<string | null>,
): void {
  window.__capture = capture
  window.__captureViews = () => Object.keys(VIEW_PRESETS) as CaptureView[]
}

export function removeCapture(): void {
  delete window.__capture
  delete window.__captureViews
}
