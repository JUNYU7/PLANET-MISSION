import { useApp } from '../store/AppContext'

function Item({ label, value, cls = '' }: { label: string; value: string; cls?: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-[9px] uppercase text-bone-faint" style={{ letterSpacing: '0.12em' }}>
        {label}
      </span>
      <span className={`num text-bone-dim ${cls}`}>{value}</span>
    </span>
  )
}

/** 底部任务状态行：数据来源与渲染状况一览（样式与事件流/读数条统一） */
export default function StatusBar() {
  const { region, tier, fps } = useApp()
  if (!region) return null
  const meta = region.meta
  const manifest = region.manifest[tier]

  const fpsColor =
    fps >= 50 ? 'text-signal-pass' : fps >= 30 ? 'text-signal-slow' : 'text-signal-forbid'

  return (
    <footer className="fixed bottom-0 left-0 right-0 h-7 bg-ink-900/95 backdrop-blur border-t border-ink-600 flex items-center px-3 gap-4 num text-[11px] z-10 overflow-x-auto whitespace-nowrap">
      <span className="text-bone">{meta.name.replace(/_/g, ' ')}</span>
      <span className="w-px h-3.5 bg-ink-600" />
      <Item label="m/px" value={meta.resolution_m.toFixed(1)} />
      <Item label="grid" value={`${manifest.grid}²`} />
      <span className="w-px h-3.5 bg-ink-600" />
      <Item
        label="rel"
        value={
          meta.height_range[1] - meta.height_range[0] > 0
            ? `${meta.height_range[0].toFixed(1)} ~ ${meta.height_range[1].toFixed(1)} m`
            : `${meta.height_range[0].toFixed(1)} m`
        }
      />
      <Item
        label="elev"
        value={`${meta.elevation_absolute_range[0].toFixed(1)} ~ ${meta.elevation_absolute_range[1].toFixed(1)} m`}
      />
      <span className="w-px h-3.5 bg-ink-600" />
      <Item label="fps" value={String(fps)} cls={fpsColor} />
      <span className="ml-auto text-bone-faint">
        {meta.crs} · {meta.license}
      </span>
    </footer>
  )
}
