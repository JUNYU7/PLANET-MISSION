import { useRef, useState } from 'react'
import type { LiveDone, LiveFrame } from '../types'
import LidarScope from './LidarScope'
import AttitudeGyro from './AttitudeGyro'
import MiniChart from './MiniChart'

interface Props {
  frame: LiveFrame | null
  done: LiveDone | null
  error: string | null
  /** 火星车速度倍率（v_max × scale），运行期可调 */
  roverSpeed: number
  onRoverSpeedChange: (v: number) => void
  follow: boolean
  onFollowChange: (v: boolean) => void
  onClose: () => void
}

/** 火星车速度倍率选项（相对 surrogate 基准速度 1 m/s） */
const ROVER_SPEEDS: Array<{ label: string; value: number }> = [
  { label: '0.5×', value: 0.5 },
  { label: '1×', value: 1 },
  { label: '2×', value: 2 },
  { label: '4×', value: 4 },
  { label: '8×', value: 8 },
]

/**
 * 车载仪表面板（ROVER INSTRUMENTS）。
 *
 * 布局自上而下：LED 状态灯行（COMM/NAV/LIDAR/SLIP）→ 任务进度 →
 * 2×2 微型读数格（位置/速度/滑转/能耗）→ LIDAR 雷达扇面（带
 * 最近障碍读数）→ IMU 陀螺仪与姿态读数 → 速度-高程走势图 →
 * 车速调节与相机跟随。可拖拽。
 */

/** LED 指示灯：dot 颜色由状态决定 */
function Led({ on, warn, label }: { on: boolean; warn?: boolean; label: string }) {
  const color = warn
    ? 'bg-rust-bright shadow-[0_0_5px_rgba(232,97,60,0.9)] animate-pulse'
    : on
      ? 'bg-signal-marker shadow-[0_0_4px_rgba(0,229,255,0.8)]'
      : 'bg-ink-500'
  return (
    <span className="flex items-center gap-1">
      <span className={`w-1.5 h-1.5 rounded-full ${color}`} />
      <span className="readout-label">{label}</span>
    </span>
  )
}

/** 2×2 微型读数格 */
function Cell({ k, v, accent }: { k: string; v: string; accent?: boolean }) {
  return (
    <div className="border border-ink-600/70 bg-ink-900/40 px-2 py-1">
      <div className="readout-label">{k}</div>
      <div
        className={`num text-[12px] ${accent ? 'text-rust-bright' : 'text-bone'}`}
      >
        {v}
      </div>
    </div>
  )
}

export default function TelemetryPanel({
  frame,
  done,
  error,
  roverSpeed,
  onRoverSpeedChange,
  follow,
  onFollowChange,
  onClose,
}: Props) {
  // 默认位置放在画布中部偏右（避开右侧 280px 任务规划面板——
  // 上一轮仿真结束后的面板若悬浮在任务按钮上方，会吞掉其点击）
  const [pos, setPos] = useState(() => ({
    x: Math.max(window.innerWidth - 780, 240),
    y: 72,
  }))
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)

  const onHeaderDown = (ev: React.PointerEvent) => {
    dragRef.current = { dx: ev.clientX - pos.x, dy: ev.clientY - pos.y }
    ;(ev.target as HTMLElement).setPointerCapture(ev.pointerId)
  }
  const onHeaderMove = (ev: React.PointerEvent) => {
    if (!dragRef.current) return
    setPos({
      x: Math.min(Math.max(ev.clientX - dragRef.current.dx, 8),
                  window.innerWidth - 336),
      y: Math.min(Math.max(ev.clientY - dragRef.current.dy, 48),
                  window.innerHeight - 120),
    })
  }
  const onHeaderUp = () => {
    dragRef.current = null
  }

  const deg = (r: number | undefined) =>
    r === undefined ? '—' : `${((r * 180) / Math.PI).toFixed(1)}°`
  const hasStream = frame !== null
  const moving = (frame?.v ?? 0) > 0.05
  const slipping = (frame?.slip ?? 0) > 0.25

  return (
    <div
      className="fixed z-30 console-panel hud-corners w-[320px] shadow-lg shadow-black/50 select-none"
      style={{ left: pos.x, top: pos.y }}
    >
      {/* 拖拽头 */}
      <div
        className="console-header flex items-center justify-between cursor-move"
        onPointerDown={onHeaderDown}
        onPointerMove={onHeaderMove}
        onPointerUp={onHeaderUp}
      >
        <span>Rover Instruments · 车载仪器</span>
        <button
          type="button"
          className="text-bone-faint hover:text-rust-bright text-xs normal-case tracking-normal"
          onClick={onClose}
          title="关闭（中止仿真）"
        >
          ✕
        </button>
      </div>

      <div className="p-2.5 space-y-2">
        {/* LED 状态灯行 + 任务阶段 + 任务时间 */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <Led on={hasStream} label="COMM" />
            <Led on={moving} label="NAV" />
            <Led on={(frame?.lidar.length ?? 0) > 0} label="LIDAR" />
            <Led on={!slipping} warn={slipping} label="SLIP" />
          </div>
          <span className="num text-[10px] text-bone-faint">
            {frame ? `T+${frame.t.toFixed(1)}s` : '—'}
          </span>
        </div>

        {/* 任务进度 */}
        <div className="num text-[11px] space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-signal-marker">
              {frame?.progress.label ??
                (done ? (done.metrics.success ? '✓ 已结束' : '✗ 已结束') : '待机')}
            </span>
            {frame?.progress.dist_to_goal_m != null && (
              <span className="num text-[10px] text-bone-dim">
                距目标 {frame.progress.dist_to_goal_m.toFixed(1)} m
              </span>
            )}
          </div>
          {frame?.progress.ratio != null && (
            <div className="h-1 bg-ink-600">
              <div
                className="h-full bg-signal-marker"
                style={{ width: `${Math.round(frame.progress.ratio * 100)}%` }}
              />
            </div>
          )}
        </div>

        {/* 顶点成像计数（SURVEY_PATH） */}
        {frame?.photos != null && (
          <div className="num text-[11px] flex items-center justify-between gap-2">
            <span className="readout-label">CAM 顶点成像</span>
            <span className={frame.photos >= 3 ? 'text-signal-pass' : 'text-bone'}>
              {frame.photos}/3 张（朝质点）
            </span>
          </div>
        )}

        {/* 雷达成像进度（TARGETED_APPROACH 扫描阶段） */}
        {frame?.radar && (
          <div className="num text-[11px] space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="readout-label">RADAR 地形扫描</span>
              <span className="text-bone">
                {(frame.radar.coverage * 100).toFixed(0)}% · 第{' '}
                {frame.radar.sweep + 1} 圈
              </span>
            </div>
            <div className="h-1 bg-ink-600">
              <div
                className="h-full bg-signal-marker"
                style={{
                  width: `${Math.round(frame.radar.coverage * 100)}%`,
                }}
              />
            </div>
          </div>
        )}

        {/* 2×2 微型读数格：位置 / 速度 / 滑转 / 能耗 */}
        <div className="grid grid-cols-2 gap-1.5">
          <Cell
            k="POS 位置"
            v={
              frame
                ? `E${frame.x >= 0 ? '+' : ''}${frame.x.toFixed(1)} S${frame.y >= 0 ? '+' : ''}${frame.y.toFixed(1)}`
                : '—'
            }
          />
          <Cell k="VEL 速度" v={frame ? `${frame.v.toFixed(2)} m/s` : '—'} accent={moving} />
          <Cell
            k="SLIP 滑转"
            v={frame ? `${(frame.slip * 100).toFixed(1)} %` : '—'}
            accent={slipping}
          />
          <Cell k="ENERGY 能耗" v={frame ? `${frame.energy_wh.toFixed(2)} Wh` : '—'} />
        </div>

        {error && (
          <div className="num text-[11px] text-rust-bright break-all">{error}</div>
        )}

        {/* LIDAR 雷达扇面（含最近障碍读数） */}
        <LidarScope
          lidar={frame?.lidar ?? null}
          range={frame?.lidar_range ?? 12}
        />

        {/* IMU 姿态：三维陀螺仪 + 数字读数 */}
        <div className="flex items-start gap-2.5">
          <AttitudeGyro normal={frame?.normal ?? null} yaw={frame?.yaw ?? 0} />
          <div className="num text-[11px] space-y-1 pt-1.5 flex-1">
            {([['PITCH 俯仰', frame?.pitch], ['ROLL 横滚', frame?.roll]] as const).map(
              ([label, v]) => (
                <div key={label} className="flex justify-between gap-2">
                  <span className="readout-label">{label}</span>
                  <span>{deg(v)}</span>
                </div>
              ),
            )}
            <div className="flex justify-between gap-2">
              <span className="readout-label">YAW 航向</span>
              <span>{frame ? deg(frame.yaw) : '—'}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="readout-label">角速度</span>
              <span>{frame ? `${frame.w.toFixed(2)} rad/s` : '—'}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="readout-label">坡度</span>
              <span>{frame ? `${frame.slope_deg.toFixed(1)}°` : '—'}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="readout-label">地形</span>
              <span className="truncate" title={frame ? `${frame.semantic} · ${frame.ti}` : undefined}>
                {frame ? `${frame.semantic}` : '—'}
              </span>
            </div>
          </div>
        </div>

        {/* 速度-高程走势图 */}
        <MiniChart speed={frame ? frame.v : null} alt={frame ? frame.height : null} />

        {/* 车速调节 */}
        <div className="flex items-center gap-2 pt-1.5 border-t border-ink-600/70">
          <span className="readout-label shrink-0">车速</span>
          <div className="flex flex-1">
            {ROVER_SPEEDS.map((s) => (
              <button
                key={s.label}
                type="button"
                className={`btn flex-1 text-[10px] px-1 ${roverSpeed === s.value ? 'btn-active' : ''}`}
                onClick={() => onRoverSpeedChange(s.value)}
                title="调节火星车行驶速度（实时生效）"
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <label className="flex items-center gap-2 cursor-pointer pb-0.5">
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => onFollowChange(e.target.checked)}
            className="accent-rust"
          />
          <span className="text-bone-dim text-xs">相机跟随小车</span>
        </label>
      </div>
    </div>
  )
}
