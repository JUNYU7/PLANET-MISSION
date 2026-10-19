import { useEffect, useRef } from 'react'

/**
 * LIDAR 雷达扇面（canvas 2D，荧光屏风格）。
 *
 * 32 线前向 180° 扇区，车头朝上、车在圆心：相邻回波连成障碍包络，
 * 近距琥珀 / 远距青色；量程环 3/6/9/12 m；慢速扫描线为纯装饰。
 * 数据来自 SSE 帧的 lidar 数组（归一化距离 0–1 × 量程）。
 */

interface Props {
  lidar: number[] | null
  range: number
}

const W = 296
const H = 158
const CX = W / 2
const CY = H - 18 // 圆心偏下，留出前向扇面
const RADIUS = H - 34

export default function LidarScope({ lidar, range }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dataRef = useRef({ lidar, range })
  dataRef.current = { lidar, range }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = W * dpr
    canvas.height = H * dpr
    ctx.scale(dpr, dpr)

    let raf = 0
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      const t = now / 1000

      ctx.clearRect(0, 0, W, H)
      // 底色
      ctx.fillStyle = 'rgba(10, 12, 14, 0.9)'
      ctx.fillRect(0, 0, W, H)

      const rMax = RADIUS
      // 量程环 3/6/9/12 m
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.18)'
      ctx.fillStyle = 'rgba(168, 150, 136, 0.8)'
      ctx.lineWidth = 1
      ctx.font = '8px Consolas, monospace'
      for (let m = 3; m <= 12; m += 3) {
        const r = (m / 12) * rMax
        ctx.beginPath()
        ctx.arc(CX, CY, r, Math.PI, Math.PI * 2)
        ctx.stroke()
        ctx.fillText(`${m}m`, CX + 3, CY - r - 2)
      }
      // 角度刻度线（-60/-30/0/30/60）
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.12)'
      for (const a of [-60, -30, 0, 30, 60]) {
        const rad = ((a - 90) * Math.PI) / 180
        ctx.beginPath()
        ctx.moveTo(CX, CY)
        ctx.lineTo(CX + Math.cos(rad) * rMax, CY + Math.sin(rad) * rMax)
        ctx.stroke()
      }

      const { lidar: rays, range: rng } = dataRef.current

      // 扫描线（装饰）：0.6 rad/s 在扇区内往复
      const sweep = ((t * 0.6) % Math.PI) - Math.PI / 2 // -90..90
      for (let k = 0; k < 6; k++) {
        const a = sweep - k * 0.035
        const rad = ((a) * Math.PI) / 180
        ctx.strokeStyle = `rgba(0, 229, 255, ${0.35 - k * 0.055})`
        ctx.beginPath()
        ctx.moveTo(CX, CY)
        ctx.lineTo(CX + Math.cos(rad) * rMax, CY + Math.sin(rad) * rMax)
        ctx.stroke()
      }

      if (!rays || rays.length === 0) {
        ctx.fillStyle = 'rgba(168, 150, 136, 0.7)'
        ctx.font = '10px Consolas, monospace'
        ctx.fillText('等待数据流 …', CX - 34, CY - rMax / 2)
      } else {
        const n = rays.length
        // 障碍包络：相邻回波连线 + 半透明填充
        ctx.beginPath()
        for (let i = 0; i < n; i++) {
          const a = (-90 + (180 * i) / (n - 1)) * (Math.PI / 180)
          const r = Math.min(rays[i], 1) * rng * (rMax / 12)
          const px = CX + Math.sin(a) * r
          const py = CY - Math.cos(a) * r
          if (i === 0) ctx.moveTo(px, py)
          else ctx.lineTo(px, py)
        }
        ctx.strokeStyle = 'rgba(0, 229, 255, 0.55)'
        ctx.lineWidth = 1
        ctx.stroke()
        ctx.lineTo(CX, CY)
        ctx.closePath()
        ctx.fillStyle = 'rgba(0, 229, 255, 0.07)'
        ctx.fill()

        // 回波点：按距离着色（近琥珀 / 中黄 / 远青）
        let minI = -1
        let minD = Infinity
        for (let i = 0; i < n; i++) {
          const a = (-90 + (180 * i) / (n - 1)) * (Math.PI / 180)
          const d = Math.min(rays[i], 1)
          if (d < minD) {
            minD = d
            minI = i
          }
          const r = d * rng * (rMax / 12)
          const px = CX + Math.sin(a) * r
          const py = CY - Math.cos(a) * r
          ctx.fillStyle =
            d < 0.3 ? '#E8613C' : d < 0.65 ? '#FFD60A' : 'rgba(0,229,255,0.85)'
          ctx.fillRect(px - 1.5, py - 1.5, 3, 3)
        }

        // 最近障碍读数 + 正前扇区（±30°）警示
        ctx.font = '9px Consolas, monospace'
        ctx.textAlign = 'left'
        if (minI >= 0 && minD < 1) {
          const bearing = -90 + (180 * minI) / (n - 1)
          const isFront = Math.abs(bearing) <= 30
          ctx.fillStyle = 'rgba(0, 229, 255, 0.8)'
          ctx.fillText(
            `MIN ${(minD * rng).toFixed(1)}m @ ${bearing >= 0 ? '+' : ''}${bearing.toFixed(0)}°`,
            5,
            11,
          )
          ctx.fillStyle = 'rgba(168, 150, 136, 0.55)'
          ctx.fillText(`RAYS ${n}`, 5, 22)
          if (isFront && minD * rng < 1.5) {
            ctx.fillStyle = '#E8613C'
            ctx.fillText('⚠ PROX', CX + 22, 11)
          }
        } else {
          ctx.fillStyle = 'rgba(0, 229, 255, 0.8)'
          ctx.fillText(`MIN > ${rng.toFixed(0)}m`, 5, 11)
          ctx.fillStyle = 'rgba(168, 150, 136, 0.55)'
          ctx.fillText(`RAYS ${n}`, 5, 22)
        }
        ctx.textAlign = 'left'
      }

      // 车体标记：中心三角，车头朝上
      ctx.fillStyle = '#F5EDE6'
      ctx.beginPath()
      ctx.moveTo(CX, CY - 5)
      ctx.lineTo(CX - 3.5, CY + 4)
      ctx.lineTo(CX + 3.5, CY + 4)
      ctx.closePath()
      ctx.fill()
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
