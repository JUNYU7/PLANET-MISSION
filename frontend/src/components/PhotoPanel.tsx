import { useRef, useState } from 'react'
import type { CapturedPhoto } from '../types'

interface Props {
  photos: CapturedPhoto[]
  onClose: () => void
}

/**
 * 顶点成像照片墙（SURVEY_PATH）。
 *
 * 照片本体由 RegionView 在收到后端 photo_events 时，以「火星车桅杆
 * 相机位姿 → 看向质心 → 任务 fov」离屏渲染一帧生成（与地图同源），
 * 此处只做展示与下载。窗口可拖拽。
 */
export default function PhotoPanel({ photos, onClose }: Props) {
  const [pos, setPos] = useState(() => ({
    x: 240,
    y: 72,
  }))
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)

  if (photos.length === 0) return null
  return (
    <div
      className="fixed z-30 console-panel hud-corners w-[300px] shadow-lg shadow-black/50 select-none"
      style={{ left: pos.x, top: pos.y }}
    >
      <div
        className="console-header flex items-center justify-between cursor-move"
        onPointerDown={(ev) => {
          dragRef.current = {
            dx: ev.clientX - pos.x,
            dy: ev.clientY - pos.y,
          }
          ;(ev.target as HTMLElement).setPointerCapture(ev.pointerId)
        }}
        onPointerMove={(ev) => {
          if (!dragRef.current) return
          setPos({
            x: Math.min(
              Math.max(ev.clientX - dragRef.current.dx, 8),
              window.innerWidth - 320,
            ),
            y: Math.min(
              Math.max(ev.clientY - dragRef.current.dy, 48),
              window.innerHeight - 120,
            ),
          })
        }}
        onPointerUp={() => {
          dragRef.current = null
        }}
      >
        <span>Camera · 顶点成像 {photos.length}/3</span>
        <button
          type="button"
          className="text-bone-faint hover:text-rust-bright text-xs normal-case tracking-normal"
          onClick={onClose}
          title="关闭照片墙（不影响仿真）"
        >
          ✕
        </button>
      </div>
      <div className="p-2 space-y-2 max-h-[62vh] overflow-y-auto">
        {photos.map((p) => (
          <figure
            key={p.vertex}
            className="border border-ink-600/70 bg-ink-900/40"
          >
            <img
              src={p.url}
              alt={`顶点 ${p.vertex + 1} 朝向质点成像`}
              className="w-full block"
            />
            <figcaption className="num text-[10px] text-bone-faint px-2 py-1 leading-relaxed">
              <span className="text-bone">顶点 {p.vertex + 1}</span> · T+
              {p.t.toFixed(1)}s · fov {p.fov.toFixed(0)}°
              <br />
              E{p.x.toFixed(1)} S{p.y.toFixed(1)} · 光轴指向质点
              <a
                href={p.url}
                download={`photo_v${p.vertex + 1}_t${p.t.toFixed(0)}s.png`}
                className="text-signal-marker hover:text-bone ml-1"
              >
                下载
              </a>
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  )
}
