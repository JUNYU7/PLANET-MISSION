import * as THREE from 'three'

/**
 * 火星天空。
 *
 * 设计依据是物理事实而非美术偏好：火星大气密度约为地球的百分之一，
 * 不存在地球式的瑞利散射蓝天。真实火星景观的特征是天空偏暗、对比度高、
 * 阴影锐利、地平线清晰。因此这里采用低饱和的暗棕红渐变而非明亮橙蓝，
 * 并在地平线附近加入太阳光晕——稀薄大气使太阳周围出现明显亮晕。
 *
 * 若把天空做成雾蒙蒙的亮橙色，视觉上更「好看」，但违背事实，
 * 且与地形的光照方向自相矛盾。
 */

export interface SkyOptions {
  /** 天顶色 */
  zenith: number
  /** 地平线色 */
  horizon: number
  /** 太阳光晕色 */
  glow: number
  /** 天空半径，需大于场景包围盒 */
  radius: number
  /** 地理纬度与赤纬，用于把地方时映射为太阳高度 */
  latitudeDeg: number
  axialTiltDeg: number
  /** 火星太阳日长度（小时） */
  solHours: number
}

export const MARS_SKY_PRESET: Omit<SkyOptions, 'radius'> = {
  zenith: 0x4e3a30,
  horizon: 0xa87050,
  glow: 0xffd9a0,
  latitudeDeg: 18.4544,
  axialTiltDeg: 25.2,
  solHours: 24.6597,
}

const VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vDir;
  uniform vec3 uSunDir;
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uGlow;

  void main() {
    vec3 d = normalize(vDir);

    // 天顶到地平线非线性渐变，指数使地平线附近更亮
    float t = pow(clamp(1.0 - d.y, 0.0, 1.0), 1.9);
    vec3 col = mix(uZenith, uHorizon, t);

    // 与太阳的角距离
    float ang = acos(clamp(dot(d, uSunDir), -1.0, 1.0));

    // 宽光晕：稀薄大气使太阳周围出现明显亮晕
    col += uGlow * exp(-ang * 4.0) * 1.3;

    // 日面
    col += vec3(1.0, 0.95, 0.88) * smoothstep(0.010, 0.006, ang) * 3.0;

    // three.js 启用 ColorManagement 时会把 uniform 中的 THREE.Color
    // 由 sRGB 转到线性空间，而 ShaderMaterial 不会自动补上输出端的
    // 线性→sRGB 转换，导致天空比预期暗约三倍、接近全黑。此处显式转换。
    vec3 srgb = mix(
      col * 12.92,
      1.055 * pow(max(col, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
      step(vec3(0.0031308), col)
    );
    gl_FragColor = vec4(srgb, 1.0);
  }
`

export interface SkyDome {
  mesh: THREE.Mesh
  setSunDirection: (dir: THREE.Vector3) => void
  dispose: () => void
}

/**
 * 由地方时计算太阳方向（+X 东，+Y 上，+Z 南）。
 *
 * 火星太阳日长 24.6597 小时，与地球 24 小时不同；赤纬约 25.2°。
 *
 * 时角 h 必须以当地正午为零点：
 *     h = (地方时 − 太阳日长 / 2) / 太阳日长 × 360°
 * 若按午夜为零点计算，会导致正午时太阳反而位于地平线以下，
 * 昼夜完全颠倒。该偏移是天文标准公式的一部分，不可省略。
 */
export function sunDirection(
  localHour: number,
  latitudeDeg: number,
  axialTiltDeg: number,
  solHours: number,
): THREE.Vector3 {
  const lat = (latitudeDeg * Math.PI) / 180
  const dec = (axialTiltDeg * Math.PI) / 180
  const h = (((localHour - solHours / 2) / solHours) * Math.PI * 2) % (Math.PI * 2)

  const sinAlt =
    Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(h)
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)))

  const cosAz =
    (Math.sin(dec) - Math.sin(alt) * Math.sin(lat)) /
    (Math.max(Math.cos(alt), 1e-6) * Math.cos(lat))
  const az = Math.acos(Math.max(-1, Math.min(1, cosAz)))

  return new THREE.Vector3(
    Math.cos(alt) * Math.cos(az),
    Math.sin(alt),
    Math.cos(alt) * Math.sin(az),
  ).normalize()
}

/** 太阳高度角（度），用于界面显示。 */
export function sunAltitude(
  localHour: number,
  latitudeDeg: number,
  axialTiltDeg: number,
  solHours: number,
): number {
  const dir = sunDirection(localHour, latitudeDeg, axialTiltDeg, solHours)
  return (Math.asin(Math.max(-1, Math.min(1, dir.y))) * 180) / Math.PI
}

export function createSkyDome(opts: SkyOptions): SkyDome {
  const uniforms = {
    uSunDir: { value: new THREE.Vector3(1, 0.3, 0.4).normalize() },
    uZenith: { value: new THREE.Color(opts.zenith) },
    uHorizon: { value: new THREE.Color(opts.horizon) },
    uGlow: { value: new THREE.Color(opts.glow) },
  }

  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
  })

  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(opts.radius, 48, 32),
    material,
  )
  mesh.renderOrder = -1000
  mesh.frustumCulled = false

  return {
    mesh,
    setSunDirection: (dir: THREE.Vector3) => {
      uniforms.uSunDir.value.copy(dir)
    },
    dispose: () => {
      mesh.geometry.dispose()
      material.dispose()
    },
  }
}