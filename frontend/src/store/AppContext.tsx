import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { LayerId, QualityTier, RegionDetail, ViewMode } from '../types'

interface AppState {
  view: ViewMode
  region: RegionDetail | null
  tier: QualityTier
  /**
   * 画质档：标准 = 1025 网格 / 2048 纹理 / 1024 阴影 / 1.25 像素比；
   * 高清 = 2049 网格 / 4096 纹理 / 2048 阴影 / 1.5–2 像素比。
   * 内部映射到 tier（standard→interactive，high→capture），
   * 对外只暴露画质语义，不再有「出图档」这类与演示无关的命名。
   */
  quality: 'standard' | 'high'
  /** 任务规划模式：区域视图内点击地形放置任务点（第 28.2 节） */
  planning: boolean
  layers: Record<LayerId, boolean>
  layerOpacity: Record<LayerId, number>
  /** 地方时，0–24 小时，驱动太阳位置与阴影方向 */
  localHour: number
  /**
   * 垂直夸张系数，仅影响三维显示，不参与任何指标计算。
   * 实测该区域 1 km 内高差仅 70.6 m，火星车眼高约 2 m，真实比例下
   * 地形在第一人称视角中显得极矮小。默认 2.5 倍，与行星地形图惯例一致。
   */
  exaggeration: number
  fps: number
}

interface AppActions {
  setView: (v: ViewMode) => void
  openRegion: (r: RegionDetail) => void
  setTier: (t: QualityTier) => void
  /** 画质档切换，同时驱动内部 tier */
  setQuality: (q: 'standard' | 'high') => void
  setPlanning: (v: boolean) => void
  toggleLayer: (id: LayerId) => void
  setLayerOpacity: (id: LayerId, v: number) => void
  resetLayers: () => void
  setLocalHour: (h: number) => void
  setExaggeration: (v: number) => void
  /** 100 m 参照网格开关，用于判读地形尺度 */
  showGrid: boolean
  setShowGrid: (v: boolean) => void
  setFps: (n: number) => void
}

const AppContext = createContext<(AppState & AppActions) | null>(null)

const ALL_LAYERS: LayerId[] = [
  'color',
  'hillshade',
  'slope',
  'curvature',
  'roughness',
  'traversability',
  'semantic',
]

const DEFAULT_LAYERS: Record<LayerId, boolean> = {
  color: true,
  hillshade: false,
  slope: false,
  curvature: false,
  roughness: false,
  traversability: false,
  semantic: false,
}

const DEFAULT_OPACITY: Record<LayerId, number> = {
  color: 1,
  hillshade: 0.85,
  slope: 0.9,
  curvature: 0.9,
  roughness: 0.9,
  traversability: 0.92,
  semantic: 0.9,
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<ViewMode>('globe')
  const [region, setRegion] = useState<RegionDetail | null>(null)
  const [tier, setTier] = useState<QualityTier>('interactive')
  const [quality, setQualityState] = useState<'standard' | 'high'>('standard')
  const [planning, setPlanning] = useState(false)
  const [layers, setLayers] = useState<Record<LayerId, boolean>>({
    ...DEFAULT_LAYERS,
  })
  const [layerOpacity, setLayerOpacity] = useState<Record<LayerId, number>>({
    ...DEFAULT_OPACITY,
  })
  // 默认地方时取 8:30：此时火星太阳高度角约 37°，光线斜射使地形阴影
  // 拉长，起伏的明暗对比最强。高度角过高（如正午 83°）时阴影极短，
  // 平缓地形会显得完全平坦。
  const [localHour, setLocalHour] = useState(8.5)
  // 默认垂直夸张 2.5 倍：70.6 m 高差放大后约 176 m，配合 2 m 眼高与
  // 远山脊形成可辨识的起伏，同时不至于失真到无法辨认地貌。
  const [exaggeration, setExaggeration] = useState(2.5)
  const [showGrid, setShowGrid] = useState(false)
  const [fps, setFps] = useState(0)

  const setQuality = useCallback((q: 'standard' | 'high') => {
    setQualityState(q)
    setTier(q === 'high' ? 'capture' : 'interactive')
  }, [])

  const toggleLayer = useCallback((id: LayerId) => {
    setLayers((prev) => ({ ...prev, [id]: !prev[id] }))
  }, [])

  const setLayerOpacityById = useCallback((id: LayerId, v: number) => {
    setLayerOpacity((prev) => ({ ...prev, [id]: v }))
  }, [])

  const resetLayers = useCallback(() => {
    setLayers({ ...DEFAULT_LAYERS })
    setLayerOpacity({ ...DEFAULT_OPACITY })
  }, [])

  const openRegion = useCallback((r: RegionDetail) => {
    // 同名区域保持对象引用不变：RegionView 的场景重建 effect 以 region
    // 身份为依赖，重复进入同一区域（再点标记、顶栏按钮、或焦点残留在
    // 按钮上时按空格误触发）不应导致整个三维场景重新加载。
    setRegion((prev) => (prev && prev.meta.name === r.meta.name ? prev : r))
    setView('region')
  }, [])

  const value = useMemo<AppState & AppActions>(
    () => ({
      view,
      region,
      tier,
      quality,
      planning,
      layers,
      layerOpacity,
      localHour,
      exaggeration,
      fps,
      setView,
      openRegion,
      setTier,
      setQuality,
      setPlanning,
      toggleLayer,
      setLayerOpacity: setLayerOpacityById,
      resetLayers,
      setLocalHour,
      setExaggeration,
      showGrid,
      setShowGrid,
      setFps,
    }),
    [
      view,
      region,
      tier,
      quality,
      planning,
      layers,
      layerOpacity,
      localHour,
      exaggeration,
      showGrid,
      fps,
      openRegion,
      setQuality,
      toggleLayer,
      setLayerOpacityById,
      resetLayers,
    ],
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) {
    console.error('useApp 必须在 AppProvider 内使用')
    throw new Error('useApp 必须在 AppProvider 内使用')
  }
  return ctx
}

export { ALL_LAYERS }