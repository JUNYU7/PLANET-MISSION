import * as THREE from 'three'

/**
 * 近地漂浮沙尘。
 *
 * 这是辨识度最高的火星视觉元素：悬浮尘粒随视线移动，在贴地视角下
 * 形成明显的空间感与大气透视。实现成本极低，无需粒子系统。
 *
 * 粒子盒体跟随相机水平位置并循环环绕，配合缓慢的垂直飘动与横向扰动，
 * 达到尘埃持续飘浮的效果。粒子数随质量档位调整。
 */

export interface DustOptions {
  count: number
  /** 粒子盒体边长（米） */
  boxSize: number
  /** 盒体高度（米） */
  boxHeight: number
  color: number
  opacity: number
  /** 单个粒子屏幕尺寸 */
  size: number
}

export const DUST_PRESET_INTERACTIVE: DustOptions = {
  count: 1400,
  boxSize: 120,
  boxHeight: 90,
  color: 0xc99070,
  opacity: 0.3,
  size: 0.5,
}

export const DUST_PRESET_CAPTURE: DustOptions = {
  count: 5000,
  boxSize: 120,
  boxHeight: 90,
  color: 0xc99070,
  opacity: 0.24,
  size: 0.5,
}

/**
 * 生成柔和圆形粒子贴图。
 *
 * PointsMaterial 在无贴图时渲染为硬边方块，近处看起来像彩色像素块
 * 而非悬浮尘埃。用径向渐变贴图使粒子边缘自然衰减。
 */
function makeDotTexture(): THREE.Texture {
  const size = 32
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const g = ctx.createRadialGradient(
      size / 2,
      size / 2,
      0,
      size / 2,
      size / 2,
      size / 2,
    )
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.45, 'rgba(255,255,255,0.55)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, size, size)
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

export interface DustField {
  points: THREE.Points
  /** 每帧调用，传入相机位置与时间增量 */
  update: (cameraPos: THREE.Vector3, dt: number, elapsed: number) => void
  dispose: () => void
}

export function createDustField(opts: DustOptions): DustField {
  const positions = new Float32Array(opts.count * 3)
  const phases = new Float32Array(opts.count)
  const speeds = new Float32Array(opts.count)

  for (let i = 0; i < opts.count; i++) {
    positions[i * 3] = (Math.random() - 0.5) * opts.boxSize
    positions[i * 3 + 1] = Math.random() * opts.boxHeight
    positions[i * 3 + 2] = (Math.random() - 0.5) * opts.boxSize
    phases[i] = Math.random() * Math.PI * 2
    speeds[i] = 0.25 + Math.random() * 0.75
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))

  const dotTex = makeDotTexture()
  const mat = new THREE.PointsMaterial({
    size: opts.size,
    sizeAttenuation: true,
    color: opts.color,
    map: dotTex,
    alphaMap: dotTex,
    transparent: true,
    opacity: opts.opacity,
    depthWrite: false,
  })

  const points = new THREE.Points(geo, mat)
  points.frustumCulled = false
  points.renderOrder = 5

  const half = opts.boxSize / 2
  const halfH = opts.boxHeight / 2
  const attr = geo.getAttribute('position') as THREE.BufferAttribute
  const arr = attr.array as Float32Array

  return {
    points,
    update: (cameraPos: THREE.Vector3, dt: number, elapsed: number) => {
      // 盒体跟随相机水平位置
      for (let i = 0; i < opts.count; i++) {
        const k = i * 3
        let x = arr[k]
        const y = arr[k + 1]
        let z = arr[k + 2]

        // 缓慢西风飘移 + 正弦横向扰动
        x -= (0.8 + speeds[i] * 1.6) * dt
        z += Math.sin(elapsed * 0.4 + phases[i]) * 0.25 * dt

        // 垂直缓慢起伏，并以相机为中心环绕包裹。
        // 高度必须相对相机而非绝对 0~boxHeight：场景启用垂直夸张后
        // 相机可位于数十米高空，若粒子仍贴着 0~26 m 分布，会全部落在
        // 视野之下，第一人称视角就看不到任何沙尘。
        let ny = y + Math.sin(elapsed * 0.7 + phases[i] * 1.7) * 0.3 * dt
        const relY = ny - cameraPos.y
        if (relY > halfH) ny -= opts.boxHeight
        else if (relY < -halfH) ny += opts.boxHeight
        arr[k + 1] = ny

        // 水平环绕包裹，使粒子始终分布在相机周围的盒体内
        const dx = x - cameraPos.x
        const dz = z - cameraPos.z
        if (dx < -half) x += opts.boxSize
        else if (dx > half) x -= opts.boxSize
        if (dz < -half) z += opts.boxSize
        else if (dz > half) z -= opts.boxSize

        arr[k] = x
        arr[k + 2] = z
      }
      attr.needsUpdate = true
    },
    dispose: () => {
      geo.dispose()
      mat.dispose()
      dotTex.dispose()
    },
  }
}