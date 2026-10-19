import { useEffect, useImperativeHandle, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

/** 点云预分配上限（点/次扫描，一圈约 8400，留余量） */
const MAX_POINTS = 30000

/** 扫描区域半径（米，与后端 radar_map_radius_m 一致） */
const SCAN_RADIUS = 10

/**
 * 高程色带（低 → 高，sRGB 目标色）。
 *
 * 原实现是蓝→橙的线性插值，中点恰好是 (0.6, 0.62, 0.62) 的灰白，
 * 加上 three.js 输出为 sRGB 而顶点色被当作线性值使用（整体再发白
 * 一档），实测点云几乎全白。改为蓝→青→绿→黄→橙的多段色带：绕开
 * 白色区，且中段为高饱和的青/绿，层次清晰。
 */
const RAMP: Array<[number, number, number]> = [
  [0.10, 0.22, 0.95], // 深蓝（最低）
  [0.05, 0.72, 0.95], // 青
  [0.20, 0.88, 0.38], // 绿
  [0.98, 0.86, 0.20], // 黄
  [1.00, 0.42, 0.10], // 橙（最高）
]

/** sRGB → 线性（顶点色按线性值送入着色器，不转会整体偏亮发白） */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/** 色带采样：t∈[0,1] → 线性空间 RGB */
function rampColor(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t)) * (RAMP.length - 1)
  const i = Math.min(Math.floor(x), RAMP.length - 2)
  const f = x - i
  const a = RAMP[i]
  const b = RAMP[i + 1]
  return [srgbToLinear(a[0] + (b[0] - a[0]) * f),
    srgbToLinear(a[1] + (b[1] - a[1]) * f),
    srgbToLinear(a[2] + (b[2] - a[2]) * f)]
}

export interface RadarScanHandle {
  /** 追加一帧新增点云（相对火星车原点：dx 东, dy 南, dz 相对地面） */
  appendPoints(pts: Array<[number, number, number]>): void
  /** 更新扫描束（世界方位角 rad；active=false 时隐藏） */
  setSweep(angle: number, active: boolean): void
  /** 清空（新一轮任务） */
  clear(): void
}

interface Props {
  open: boolean
  onClose: () => void
  /** 受控 ref：父组件据此推送点云与扫描束 */
  handleRef: React.RefObject<RadarScanHandle | null>
  /** 扫描覆盖率（0–1，仅展示） */
  coverage: number
}

/**
 * 雷达地形扫描独立 3D 窗口（抵近任务扫描阶段）。
 *
 * 点云以火星车为原点直接以局部坐标渲染（x=东, z=南, y=相对地面高程），
 * 配 20 m 参考网格、火星车标记与当前扫描束；颜色按相对高程
 * （蓝低 → 橙高）。窗口可拖拽、可关闭，OrbitControls 自由查看。
 */
export default function RadarScanWindow({
  open,
  onClose,
  handleRef,
  coverage,
}: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState(() => ({
    x: Math.max(window.innerWidth - 420, 260),
    y: Math.max(window.innerHeight - 460, 120),
  }))
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  /** 色标图例数值（跟随已扫描点的实际高程范围） */
  const [zLabel, setZLabel] = useState<[string, string, string]>(
    ['—', '—', '—'],
  )

  // 场景对象（仅挂载期间存在）
  const apiRef = useRef<{
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    controls: OrbitControls
    positions: Float32Array
    colors: Float32Array
    geo: THREE.BufferGeometry
    count: number
    zMin: number
    zMax: number
    beam: THREE.Line
    frame: number
  } | null>(null)

  useImperativeHandle(handleRef as React.RefObject<RadarScanHandle>, () => ({
    appendPoints(pts) {
      const api = apiRef.current
      if (!api || pts.length === 0) return
      let zLo = api.zMin
      let zHi = api.zMax
      for (const [dx, dy, dz] of pts) {
        if (api.count >= MAX_POINTS) break
        const k = api.count
        api.positions[k * 3] = dx
        api.positions[k * 3 + 1] = dz
        api.positions[k * 3 + 2] = dy
        if (dz < zLo) zLo = dz
        if (dz > zHi) zHi = dz
        api.count = k + 1
      }
      // 色标按已扫描点的实际高程范围自适应：原写死 dz∈[-1.5,+1.5] m，
      // 而 10 m 范围内的真实起伏往往不足 ±0.5 m，所有点都落在色带
      // 中段 → 看起来一片白。自适应后色带始终铺满，层次可辨。
      api.zMin = zLo
      api.zMax = zHi
      const span = Math.max(zHi - zLo, 0.05)
      for (let i = 0; i < api.count; i++) {
        const t = (api.positions[i * 3 + 1] - zLo) / span
        const [r, g, b] = rampColor(t)
        api.colors[i * 3] = r
        api.colors[i * 3 + 1] = g
        api.colors[i * 3 + 2] = b
      }
      api.geo.setDrawRange(0, api.count)
      ;(api.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true
      ;(api.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true
      // 图例数值（色标两端与跨度）
      const lo = `${zLo.toFixed(2)}m`
      const hi = `${zHi.toFixed(2)}m`
      setZLabel((prev) => (prev[0] === lo && prev[2] === hi ? prev
        : [lo, `${(zHi - zLo).toFixed(2)}m`, hi]))
    },
    setSweep(angle, active) {
      const api = apiRef.current
      if (!api) return
      api.beam.visible = active
      if (!active) return
      const posAttr = api.beam.geometry.attributes
        .position as THREE.BufferAttribute
      // 扫描束：雷达安装高度 → 当前方位 10 m 处地面
      posAttr.setXYZ(0, Math.cos(angle) * 0.8, 2.5, Math.sin(angle) * 0.8)
      posAttr.setXYZ(
        1,
        Math.cos(angle) * SCAN_RADIUS,
        0.2,
        Math.sin(angle) * SCAN_RADIUS,
      )
      posAttr.needsUpdate = true
      api.beam.geometry.computeBoundingSphere()
    },
    clear() {
      const api = apiRef.current
      if (!api) return
      api.count = 0
      api.zMin = Infinity
      api.zMax = -Infinity
      api.geo.setDrawRange(0, 0)
      api.beam.visible = false
    },
  }))

  useEffect(() => {
    const mount = mountRef.current
    if (!mount || !open) return

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0a0e14)
    const camera = new THREE.PerspectiveCamera(
      50,
      mount.clientWidth / Math.max(mount.clientHeight, 1),
      0.1,
      500,
    )
    camera.position.set(13, 9, 13)
    camera.lookAt(0, 0, 0)

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(mount.clientWidth, mount.clientHeight)
    mount.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.target.set(0, 0.5, 0)

    // 光照：环境 + 平行（点云用 PointsMaterial 不受光照，网格/车标需要）
    scene.add(new THREE.AmbientLight(0x8899aa, 1.2))
    const dir = new THREE.DirectionalLight(0xffffff, 1.5)
    dir.position.set(8, 14, 6)
    scene.add(dir)

    // 20 m 参考网格（火星车原点处）
    const grid = new THREE.GridHelper(20, 20, 0x3a4a5a, 0x1d2733)
    scene.add(grid)

    // 火星车标记（原点小方块 + 朝向北的指示锥）
    const rover = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 0.4, 1.4),
      new THREE.MeshStandardMaterial({ color: 0xc9a24b, roughness: 0.5 }),
    )
    rover.position.y = 0.2
    scene.add(rover)
    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(0.22, 0.5, 12),
      new THREE.MeshStandardMaterial({
        color: 0x00e5ff,
        emissive: 0x00e5ff,
        emissiveIntensity: 0.8,
      }),
    )
    nose.rotation.x = Math.PI / 2 // 锥尖朝 -z（北）
    nose.position.set(0, 0.25, -0.95)
    scene.add(nose)

    // 扫描束（当前位置由 setSweep 更新）
    const beamGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3(),
    ])
    const beam = new THREE.Line(
      beamGeo,
      new THREE.LineBasicMaterial({
        color: 0x00e5ff,
        transparent: true,
        opacity: 0.9,
      }),
    )
    beam.frustumCulled = false
    beam.visible = false
    scene.add(beam)

    // 点云
    const positions = new Float32Array(MAX_POINTS * 3)
    const colors = new Float32Array(MAX_POINTS * 3)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geo.setDrawRange(0, 0)
    const points = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        size: 0.14,
        vertexColors: true,
        sizeAttenuation: true,
      }),
    )
    points.frustumCulled = false
    scene.add(points)

    const onResize = () => {
      if (!mount.clientWidth || !mount.clientHeight) return
      camera.aspect = mount.clientWidth / mount.clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(mount.clientWidth, mount.clientHeight)
    }
    window.addEventListener('resize', onResize)

    let frame = 0
    const animate = () => {
      frame = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    apiRef.current = {
      renderer, scene, camera, controls, positions, colors, geo,
      count: 0, zMin: Infinity, zMax: -Infinity, beam, frame,
    }

    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', onResize)
      controls.dispose()
      geo.dispose()
      ;(points.material as THREE.Material).dispose()
      beamGeo.dispose()
      ;(beam.material as THREE.Material).dispose()
      rover.geometry.dispose()
      ;(rover.material as THREE.Material).dispose()
      nose.geometry.dispose()
      ;(nose.material as THREE.Material).dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement)
      }
      apiRef.current = null
    }
  }, [open])

  if (!open) return null

  return (
    <div
      className="fixed z-30 console-panel hud-corners w-[360px] shadow-lg shadow-black/50 select-none"
      style={{ left: pos.x, top: pos.y }}
    >
      <div
        className="console-header flex items-center justify-between cursor-move"
        onPointerDown={(ev) => {
          dragRef.current = { dx: ev.clientX - pos.x, dy: ev.clientY - pos.y }
          ;(ev.target as HTMLElement).setPointerCapture(ev.pointerId)
        }}
        onPointerMove={(ev) => {
          if (!dragRef.current) return
          setPos({
            x: Math.min(Math.max(ev.clientX - dragRef.current.dx, 8),
                        window.innerWidth - 380),
            y: Math.min(Math.max(ev.clientY - dragRef.current.dy, 48),
                        window.innerHeight - 120),
          })
        }}
        onPointerUp={() => {
          dragRef.current = null
        }}
      >
        <span>Radar Scan · 地形扫描点云</span>
        <button
          type="button"
          className="text-bone-faint hover:text-rust-bright text-xs normal-case tracking-normal"
          onClick={onClose}
          title="关闭点云窗口（数据保留到本轮任务结束）"
        >
          ✕
        </button>
      </div>
      <div
        ref={mountRef}
        className="w-full"
        style={{ height: 300 }}
      />
      <div className="num text-[10px] text-bone-faint px-2.5 pb-2 leading-relaxed">
        以火星车为原点 · 10 m 半径 · 左键旋转 / 滚轮缩放 / 右键平移
        <br />
        扫描覆盖率{' '}
        <span className="text-bone">{(coverage * 100).toFixed(0)}%</span> ·
        颜色表示相对高程（蓝低橙高）
        <div
          className="mt-1 h-2 w-full rounded-sm"
          style={{
            background:
              'linear-gradient(to right, rgb(26,56,242), rgb(13,184,242),' +
              ' rgb(51,224,97), rgb(250,219,51), rgb(255,107,26))',
          }}
        />
        <div className="flex justify-between text-[9px]">
          <span>低 {zLabel[0]}</span>
          <span>相对高程 {zLabel[1]}</span>
          <span>高 {zLabel[2]}</span>
        </div>
      </div>
    </div>
  )
}
