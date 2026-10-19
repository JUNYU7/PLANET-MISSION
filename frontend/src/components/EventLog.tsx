import { useEffect, useRef, useState } from 'react'
import { useLogEntries, type LogLevel } from '../console/events'

const LEVEL_STYLE: Record<LogLevel, { tag: string; cls: string }> = {
  sys: { tag: 'SYS', cls: 'text-bone-dim' },
  rov: { tag: 'ROV', cls: 'text-signal-marker' },
  warn: { tag: 'WRN', cls: 'text-signal-slow' },
  err: { tag: 'ERR', cls: 'text-signal-forbid' },
}

/**
 * 事件流（EVENT LOG）：任务控制台左栏。
 *
 * 接收全局 logEvent 推送的系统 / 车辆事件，最新在底部、自动滚动；
 * 鼠标悬停或手动暂停时冻结滚动，便于回看。
 */
export default function EventLog() {
  const entries = useLogEntries()
  const [paused, setPaused] = useState(false)
  const hoverRef = useRef(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!paused && !hoverRef.current && boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight
    }
  }, [entries, paused])

  return (
    <aside className="w-[220px] shrink-0 console-panel flex flex-col pb-7 border-r-0">
      <div className="console-header flex items-center justify-between shrink-0">
        <span>Event Log · 事件流</span>
        <span className="flex gap-1.5 normal-case tracking-normal">
          <button
            type="button"
            className="text-bone-faint hover:text-rust-bright transition-colors"
            onClick={() => setPaused((p) => !p)}
            title={paused ? '继续自动滚动' : '暂停自动滚动'}
          >
            {paused ? '▶' : '❚❚'}
          </button>
        </span>
      </div>

      <div
        ref={boxRef}
        onMouseEnter={() => {
          hoverRef.current = true
        }}
        onMouseLeave={() => {
          hoverRef.current = false
        }}
        className="flex-1 overflow-y-auto px-2.5 py-2 space-y-1"
      >
        {entries.length === 0 && (
          <p className="num text-[10px] text-bone-faint leading-relaxed">
            STANDBY — 暂无事件。
            <br />
            系统与仿真事件将在此实时滚动。
          </p>
        )}
        {entries.map((e) => {
          const st = LEVEL_STYLE[e.level]
          return (
            <div key={e.id} className="num text-[10px] leading-relaxed">
              <span className="text-bone-faint">{e.time}</span>{' '}
              <span className={st.cls}>{st.tag}</span>{' '}
              <span className="text-bone-dim break-all">{e.msg}</span>
            </div>
          )
        })}
      </div>

      <div className="px-2.5 py-1.5 border-t border-ink-600/70 shrink-0">
        <span className="num text-[10px] text-bone-faint">
          {entries.length} 条 · 悬停暂停 · {paused ? '已暂停' : '跟随中'}
        </span>
      </div>
    </aside>
  )
}
