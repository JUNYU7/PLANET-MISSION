import { useEffect, useRef } from 'react'

/**
 * 速度-高程滚动走势图（canvas 2D）。
 *
 * 双曲线：琥珀=车速、青=离地高程；各按窗口内极值独立归一化，
 * 每帧追加一个采样点，窗口约 240 帧（≈1 分钟 @ 0.25s 帧距）。
 * 底部网格 + 右端当前值读数，实时仿真才推进。
 */

const W = 296
const H = 64
const PAD = 3
/** 滚动窗口长度（采样点数） */
const N = 240

interface Props {
  /** 当前车速 m/s（null=无数据流） */
  speed: number | null
  /** 当前地形高程 m */
  alt: number | null
}

export default function MiniChart({ speed, alt }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const histRef = useRef<{ v: number[]; h: number[] }>({ v: [], h: [] })
  const liveRef = useRef({ speed, alt })
  liveRef.current = { speed, alt }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = W * dpr
    canvas.height = H * dpr
    ctx.scale(dpr, dpr)

    let raf = 0
    /** 上次采样值：只在数据帧变化时追加（SSE ~4 Hz），避免按渲染帧率灌满窗口 */
    let lastV: number | null = null
    let lastH: number | null = null
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const { v, h } = histRef.current
      const cur = liveRef.current
      const hasStream = cur.speed !== null
      const changed = cur.speed !== lastV || (cur.alt ?? 0) !== (lastH ?? 0)

      ctx.clearRect(0, 0, W, H)
      ctx.fillStyle = 'rgba(10, 12, 14, 0.9)'
      ctx.fillRect(0, 0, W, H)

      // 网格：水平 3 条 + 垂直每 40 采样点
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.10)'
      ctx.lineWidth = 1
      for (let i = 1; i <= 3; i++) {
        const y = (H / 4) * i
        ctx.beginPath()
        ctx.moveTo(0, y + 0.5)
        ctx.lineTo(W, y + 0.5)
        ctx.stroke()
      }
      for (let i = 1; i * 40 < N; i++) {
        const x = W - ((i * 40) / N) * (W - PAD * 2) - PAD
        ctx.beginPath()
        ctx.moveTo(x + 0.5, 0)
        ctx.lineTo(x + 0.5, H)
        ctx.stroke()
      }

      if (!hasStream) {
        lastV = null
        lastH = null
        ctx.fillStyle = 'rgba(168, 150, 136, 0.6)'
        ctx.font = '9px Consolas, monospace'
        ctx.fillText('TREND 待数据流 …', 8, H / 2 + 3)
        return
      }
      if (changed || v.length === 0) {
        v.push(cur.speed as number)
        h.push(cur.alt ?? 0)
        if (v.length > N) v.shift()
        if (h.length > N) h.shift()
        lastV = cur.speed
        lastH = cur.alt ?? 0
      }

      const plot = (
        vals: number[],
        stroke: string,
        fill: string | null,
      ) => {
        let lo = Infinity
        let hi = -Infinity
        for (const x of vals) {
          if (x < lo) lo = x
          if (x > hi) hi = x
        }
        if (hi - lo < 1e-3) {
          hi += 5e-4
          lo -= 5e-4
        }
        const px = (i: number) =>
          PAD + (i / (N - 1)) * (W - PAD * 2)
        const py = (val: number) =>
          H - PAD - ((val - lo) / (hi - lo)) * (H - PAD * 2)
        const off = N - vals.length
        ctx.beginPath()
        for (let i = 0; i < vals.length; i++) {
          const x = px(off + i)
          const y = py(vals[i])
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.strokeStyle = stroke
        ctx.lineWidth = 1.2
        ctx.stroke()
        if (fill) {
          ctx.lineTo(px(N - 1), H - PAD)
          ctx.lineTo(px(off), H - PAD)
          ctx.closePath()
          ctx.fillStyle = fill
          ctx.fill()
        }
        return { lo, hi }
      }

      const vs = plot(v, '#E8613C', 'rgba(232, 97, 60, 0.10)')
      const hs = plot(h, '#00E5FF', null)

      // 右上角当前值读数（双行）
      ctx.font = '9px Consolas, monospace'
      ctx.fillStyle = '#E8613C'
      ctx.textAlign = 'right'
      ctx.fillText(`V ${(cur.speed as number).toFixed(2)}m/s`, W - 5, 11)
      ctx.fillStyle = '#00E5FF'
      ctx.fillText(`H ${(cur.alt ?? 0).toFixed(2)}m`, W - 5, 22)
      ctx.textAlign = 'left'
      // 窗口极值（速度）
      ctx.fillStyle = 'rgba(168, 150, 136, 0.55)'
      ctx.fillText(`${vs.lo.toFixed(2)}..${vs.hi.toFixed(2)}`, 5, H - 4)
      ctx.textAlign = 'right'
      ctx.fillText(`${hs.lo.toFixed(2)}..${hs.hi.toFixed(2)}m`, W - 5, H - 4)
      ctx.textAlign = 'left'
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{ width: W, height: H }}
      className="block border border-ink-600/70"
    />
  )
}
