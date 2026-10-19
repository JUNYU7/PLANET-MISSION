import { useState } from 'react'
import { MARS_SKY_PRESET, sunAltitude } from '../scene/SkyDome'
import { useApp } from '../store/AppContext'
import { logEvent } from '../console/events'
import { exportGazeboPackage, gazeboPackageUrl } from '../api/client'
import type { TerrainProbe } from '../types'

interface Profiles {
  east: number[]
  north: number[]
  min: number
  max: number
}

type Tab = 'target' | 'env' | 'ops'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'target', label: '区域' },
  { id: 'env', label: '环境' },
  { id: 'ops', label: '工具' },
]

function ProfileChart({ profiles }: { profiles: Profiles }) {
  const W = 200
  const H = 56
  const pad = 2

  const path = (vals: number[]) => {
    const span = profiles.max - profiles.min
    return vals
      .map((v, i) => {
        const x = pad + (i / (vals.length - 1)) * (W - pad * 2)
        const y = H - pad - ((v - profiles.min) / span) * (H - pad * 2)
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')
  }

  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} className="block">
      <polyline
        points={`${pad},${H - pad} ${W - pad},${H - pad}`}
        fill="none"
        stroke="#2A211C"
        strokeWidth="1"
      />
      <path d={path(profiles.east)} fill="none" stroke="#E8613C" strokeWidth="1.2" />
      <path d={path(profiles.north)} fill="none" stroke="#00E5FF" strokeWidth="1.2" />
    </svg>
  )
}

export default function InfoPanel({
  profiles,
  probe,
  probeEnabled,
  onProbeToggle,
}: {
  profiles: Profiles | null
  probe: TerrainProbe | null
  probeEnabled: boolean
  onProbeToggle: (on: boolean) => void
}) {
  const {
    region,
    localHour,
    setLocalHour,
    exaggeration,
    setExaggeration,
    showGrid,
    setShowGrid,
  } = useApp()
  // Hooks 必须在条件返回之前调用
  const [tab, setTab] = useState<Tab>('target')
  const [downloading, setDownloading] = useState(false)
  const [pkgError, setPkgError] = useState<string | null>(null)

  const handleDownload = async () => {
    if (!region?.meta.name) return
    setDownloading(true)
    setPkgError(null)
    try {
      // 先触发后端导出，保证下载到的是最新仿真包
      await exportGazeboPackage(region.meta.name)
      const a = document.createElement('a')
      a.href = gazeboPackageUrl(region.meta.name, 'zip')
      a.download = `${region.meta.name}_gazebo.zip`
      a.click()
      a.remove()
      logEvent('sys', `Gazebo 包导出完成 · ${region.meta.name}_gazebo.zip`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setPkgError(msg)
      logEvent('err', `Gazebo 导出失败：${msg}`)
    } finally {
      setDownloading(false)
    }
  }

  if (!region) return null
  const meta = region.meta

  const sunAlt = sunAltitude(
    localHour,
    meta.center.lat,
    MARS_SKY_PRESET.axialTiltDeg,
    MARS_SKY_PRESET.solHours,
  )

  return (
    <aside className="w-[240px] shrink-0 console-panel flex flex-col border-l-0 overflow-hidden">
      {/* 页签行 */}
      <div className="flex shrink-0 border-b border-ink-600/70">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`flex-1 py-2 text-[10px] uppercase text-bone-dim
              border-b-2 transition-colors duration-150
              ${tab === t.id
                ? 'border-rust-bright text-bone'
                : 'border-transparent hover:text-bone hover:border-ink-500'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* ── 区域：基本信息 + 高程剖面 ── */}
        {tab === 'target' && (
          <>
            <div className="console-header">Region · 区域信息</div>
            <dl className="p-3 space-y-1.5">
              <Row k="着陆点" v={`${meta.landing_site.lat.toFixed(4)}°N ${meta.landing_site.lon.toFixed(4)}°E`} />
              <Row k="裁剪中心" v={`${meta.center.lat.toFixed(4)}°N ${meta.center.lon.toFixed(4)}°E`} />
              <Row k="场景边长" v={`${meta.size_m} m`} />
              <Row k="分辨率" v={`${meta.resolution_m.toFixed(1)} m/px`} />
            </dl>

            <div className="console-header">Elevation · 高程剖面</div>
            <div className="p-3">
              {profiles ? (
                <>
                  <ProfileChart profiles={profiles} />
                  <div className="flex items-center gap-3 mt-1.5">
                    <span className="num text-[10px] text-rust-bright flex items-center gap-1">
                      <span className="w-3 h-px bg-rust-bright" />
                      东西向
                    </span>
                    <span className="num text-[10px] text-signal-marker flex items-center gap-1">
                      <span className="w-3 h-px bg-signal-marker" />
                      南北向
                    </span>
                  </div>
                  <div className="num text-[10px] text-bone-faint mt-2 leading-relaxed">
                    相对起伏 {profiles.min.toFixed(1)} ~ {profiles.max.toFixed(1)} m
                    <br />
                    绝对海拔 {meta.elevation_absolute_range[0].toFixed(1)} ~
                    {meta.elevation_absolute_range[1].toFixed(1)} m
                  </div>
                </>
              ) : (
                <p className="num text-[10px] text-bone-faint">正在采样…</p>
              )}
            </div>
          </>
        )}

        {/* ── 环境：地方时 + 显示设置 ── */}
        {tab === 'env' && (
          <>
            <div className="console-header">Lighting · 地方时与光照</div>
            <div className="p-3">
              <div className="flex items-center justify-between mb-1.5">
                <span className="num text-xs text-bone">{formatHour(localHour)}</span>
                <span className="num text-xs text-bone-dim">
                  太阳高度角 {sunAlt.toFixed(1)}°
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={24}
                step={0.05}
                value={localHour}
                onChange={(e) => setLocalHour(Number(e.target.value))}
                className="w-full"
              />
              <div className="flex justify-between num text-[10px] text-bone-faint mt-1">
                <span>0h</span>
                <span>6h</span>
                <span>12h</span>
                <span>18h</span>
                <span>24h</span>
              </div>
            </div>

            <div className="console-header">Display · 显示设置</div>
            <div className="p-3">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs text-bone-dim">垂直夸张</span>
                <span className="num text-xs text-bone">
                  {exaggeration.toFixed(1)}×
                </span>
              </div>
              <input
                type="range"
                min={1}
                max={6}
                step={0.1}
                value={exaggeration}
                onChange={(e) => setExaggeration(Number(e.target.value))}
                className="w-full"
                aria-label="垂直夸张系数"
                title="行星地形图常规做法：仅改变显示高度，不影响坡度与可通行性判定"
              />
              <div className="flex justify-between num text-[10px] text-bone-faint mt-1">
                <span>1× 真实</span>
                <span>6×</span>
              </div>

              <label className="flex items-center gap-2 mt-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showGrid}
                  onChange={(e) => setShowGrid(e.target.checked)}
                  className="accent-rust"
                />
                <span className="text-xs text-bone-dim">显示 100 m 参照网格</span>
              </label>
            </div>
          </>
        )}

        {/* ── 工具：地形探针 + Gazebo 导出 ── */}
        {tab === 'ops' && (
          <>
            <div className="console-header">Terrain Probe · 地形探针</div>
            <div className="p-3">
              <label className="flex items-center justify-between gap-2 cursor-pointer pb-2.5 border-b border-ink-600/70 mb-2.5">
                <span className="flex items-center gap-2">
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      probeEnabled
                        ? 'bg-signal-marker shadow-[0_0_4px_rgba(0,229,255,0.8)]'
                        : 'bg-ink-500'
                    }`}
                  />
                  <span className="text-xs text-bone-dim">启用探针采样</span>
                </span>
                <input
                  type="checkbox"
                  checked={probeEnabled}
                  onChange={(e) => onProbeToggle(e.target.checked)}
                  className="accent-rust"
                />
              </label>
              {probeEnabled ? (
                probe ? (
                  <dl className="space-y-1.5">
                    <Row k="位置" v={`E ${probe.x >= 0 ? '+' : ''}${probe.x.toFixed(1)} · S ${probe.y >= 0 ? '+' : ''}${probe.y.toFixed(1)}`} />
                    <Row k="高程" v={`${probe.z.toFixed(2)} m`} />
                    <Row k="坡度" v={`${probe.slope_deg.toFixed(1)}°`} />
                    <Row k="TI 等级" v={probe.ti} />
                    <Row k="语义" v={probe.semantic} />
                    <Row k="粗糙度" v={`${probe.roughness_m.toFixed(2)} m`} />
                  </dl>
                ) : (
                  <p className="num text-[10px] text-bone-faint leading-relaxed">
                    ACTIVE — 将光标移到地形上即可采样该点属性。
                  </p>
                )
              ) : (
                <p className="num text-[10px] text-bone-faint leading-relaxed">
                  OFF — 打开开关后，光标移到地形上会显示标记环并采样该点属性。
                </p>
              )}
            </div>

            <div className="console-header">Sim Export · 仿真导出</div>
            <div className="p-3">
              <button
                type="button"
                disabled={downloading}
                onClick={() => void handleDownload()}
                className="btn w-full disabled:opacity-50"
              >
                {downloading ? '导出中…' : '下载 Gazebo 包 (zip)'}
              </button>
              {pkgError && (
                <p className="num text-[10px] text-rust-bright mt-2 break-all">
                  {pkgError}
                </p>
              )}
              <dl className="mt-3 pt-2.5 border-t border-ink-600/70 space-y-1.5">
                <Row k="数据来源" v={meta.source} small />
                <Row k="许可" v={meta.license} small />
              </dl>
            </div>
          </>
        )}
      </div>

      {/* 占位：底部状态栏为 fixed 定位（高 28px），避免遮挡滚动区末尾 */}
      <div className="h-7 shrink-0" />
    </aside>
  )
}

function Row({ k, v, small }: { k: string; v: string; small?: boolean }) {
  return (
    <div className="flex justify-between gap-2 items-baseline">
      <dt className="readout-label pt-0.5">{k}</dt>
      <dd
        className={`num text-right ${small ? 'text-[10px]' : 'text-[11px]'} text-bone-dim break-all`}
      >
        {v}
      </dd>
    </div>
  )
}

function formatHour(h: number): string {
  const hh = Math.floor(h) % 24
  const mm = Math.floor((h % 1) * 60)
  return `Sol 时 ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}
