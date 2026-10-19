import { useEffect, useState } from 'react'
import GlobeView from './views/GlobeView'
import RegionView from './views/RegionView'
import { fetchRegionDetail, fetchRegions } from './api/client'
import { useApp } from './store/AppContext'

/** Sol 任务计时：时:分来自地方时，秒位随墙钟跳动（仪表氛围） */
function SolClock() {
  const { localHour } = useApp()
  const [sec, setSec] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setSec((s) => (s + 1) % 60), 1000)
    return () => clearInterval(t)
  }, [])
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    <span className="num text-xs text-bone-dim border border-ink-600/70 px-1.5 py-0.5">
      SOL {p(Math.floor(localHour) % 24)}:{p(Math.floor((localHour % 1) * 60))}:
      {p(sec)}
    </span>
  )
}

/** 分段控件：同一组互斥选项共用一个边框容器 */
function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: Array<{ value: T; label: string; title?: string }>
}) {
  return (
    <div className="flex border border-ink-500/80">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          onClick={() => onChange(o.value)}
          className={`px-2.5 py-1 text-xs transition-colors duration-150 ${
            value === o.value
              ? 'bg-ink-600 text-rust-bright'
              : 'text-bone-dim hover:text-bone hover:bg-ink-700/60'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function TopBar() {
  const { view, setView, region, openRegion, quality, setQuality, planning, setPlanning } =
    useApp()

  // 未选过区域时也能进入：自动加载第一个已注册区域。
  // 之前该按钮在 region 为空时被禁用，表现为「点了没反应」，
  // 只能靠点击球体上的标记进入区域。
  const goRegion = async () => {
    if (region) {
      setView('region')
      return
    }
    try {
      const { regions } = await fetchRegions()
      if (regions.length === 0) return
      const detail = await fetchRegionDetail(regions[0].name)
      openRegion(detail)
    } catch (e) {
      console.error('进入区域场景失败', e)
    }
  }

  return (
    <header className="fixed top-0 left-0 right-0 h-12 z-20 console-panel border-x-0 border-t-0 flex items-center px-4 gap-4">
      <div className="flex items-center gap-2.5">
        <div className="w-2 h-2 bg-rust rotate-45" />
        <span className="text-base font-semibold text-bone tracking-wide">
          PlanetMission
        </span>
        <span className="text-xs text-bone-faint hidden sm:inline">
          火星巡视器仿真环境生成与可视化平台
        </span>
      </div>

      <nav className="ml-4">
        <Segmented
          value={view}
          onChange={(v) => (v === 'region' ? void goRegion() : setView(v))}
          options={[
            { value: 'globe', label: '火星全球' },
            { value: 'region', label: '区域场景' },
          ]}
        />
      </nav>

      {/* 画质档：标准/高清。切换会重建场景（网格与贴图分辨率不同），
          有加载遮罩覆盖，耗时约 1–3 秒。 */}
      <div className="ml-auto flex items-center gap-2.5">
        <SolClock />
        {view === 'region' && (
          <button
            type="button"
            className={`btn ${planning ? 'btn-active' : ''}`}
            onClick={() => setPlanning(!planning)}
            title="任务规划：点击地形放置任务点"
          >
            任务规划
          </button>
        )}
        <Segmented
          value={quality}
          onChange={setQuality}
          options={[
            { value: 'standard', label: '标准' },
            { value: 'high', label: '高清' },
          ]}
        />
      </div>
    </header>
  )
}

function RegionPlaceholder() {
  const { setView } = useApp()
  return (
    <div className="w-full h-full flex items-center justify-center">
      <div className="panel px-6 py-5 text-center max-w-sm">
        <p className="text-base text-bone mb-2">尚未选择区域</p>
        <p className="text-xs text-bone-faint mb-4 leading-relaxed">
          从火星全球视图点击已注册区域，进入该区域的三维地形场景。
        </p>
        <button type="button" className="btn" onClick={() => setView('globe')}>
          返回火星全球
        </button>
      </div>
    </div>
  )
}

export default function App() {
  const { view, region } = useApp()

  return (
    <div className="w-full h-full">
      <TopBar />
      <main className="pt-12 w-full h-full">
        {view === 'globe' ? (
          <GlobeView />
        ) : region ? (
          <RegionView />
        ) : (
          <RegionPlaceholder />
        )}
      </main>
    </div>
  )
}
