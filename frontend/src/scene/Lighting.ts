import * as THREE from 'three'

/**
 * 光照与阴影。
 *
 * 关键设计：阴影相机跟随主相机移动，且只覆盖约 200 米，而非整个 1 km 区域。
 * 原因是阴影贴图分辨率固定，2048 分辨率覆盖 1 km 时每纹素对应 0.5 米，
 * 阴影边缘严重模糊；限定 200 米后每纹素约 0.1 米，边缘锐利——这与火星
 * 稀薄大气导致的硬阴影相符。
 */

export interface LightingRig {
  /** 当前太阳单位方向，供第一人称初始朝向使用 */
  sunDirection: () => THREE.Vector3
  sun: THREE.DirectionalLight
  ambient: THREE.AmbientLight
  hemi: THREE.HemisphereLight
  /** 每帧调用，使阴影相机跟随主相机水平位置 */
  update: (cameraPos: THREE.Vector3) => void
  dispose: () => void
}

export interface LightingOptions {
  /** 阴影相机单侧覆盖范围（米） */
  followExtent: number
  shadowMapSize: number
  /** 大气稀薄，环境光与半球光都应较弱 */
  ambientIntensity: number
  sunIntensity: number
  sunColor: number
  fogColor: number
}

export const LIGHTING_PRESET: LightingOptions = {
  followExtent: 200,
  shadowMapSize: 1024,
  // 火星表面反照率约 0.25，本身就很暗。但过暗会让地形判读困难，
  // 且截图观感差，因此取略高于物理值的强度以保证可读性。
  ambientIntensity: 0.85,
  sunIntensity: 3.4,
  sunColor: 0xfff2dc,
  fogColor: 0xb08060,
}

export function createLighting(
  scene: THREE.Scene,
  opts: LightingOptions,
): LightingRig {
  const sun = new THREE.DirectionalLight(opts.sunColor, opts.sunIntensity)
  sun.castShadow = true
  sun.shadow.mapSize.set(opts.shadowMapSize, opts.shadowMapSize)

  const ext = opts.followExtent
  sun.shadow.camera.left = -ext
  sun.shadow.camera.right = ext
  sun.shadow.camera.top = ext
  sun.shadow.camera.bottom = -ext
  sun.shadow.camera.near = 1
  sun.shadow.camera.far = ext * 4
  sun.shadow.bias = -0.0006
  sun.shadow.normalBias = 0.02

  // 火星大气稀薄，无地球式的强漫射。天光偏弱但仍需保留暗部细节，
  // 因此用低强度半球光补一点来自地面的反射。
  const ambient = new THREE.AmbientLight(0x6b5d54, opts.ambientIntensity)
  const hemi = new THREE.HemisphereLight(0xc08457, 0x3a2418, 0.35)

  scene.add(sun)
  scene.add(ambient)
  scene.add(hemi)

  const sunOffset = new THREE.Vector3()
  const follow = new THREE.Vector3()

  return {
    /** 当前太阳单位方向，供第一人称初始朝向使用 */
    sunDirection: () => sunOffset.clone().normalize(),

    sun,
    ambient,
    hemi,
    update: (cameraPos: THREE.Vector3) => {
      // 阴影相机跟随主相机水平位置，使阴影贴图始终用在近处，
      // 而不是平摊到整个场景
      follow.set(cameraPos.x, 0, cameraPos.z)
      sunOffset.copy(sun.position).normalize().multiplyScalar(ext * 2)
      sun.target.position.copy(follow)
      sun.position.copy(follow).add(sunOffset)
      sun.target.updateMatrixWorld()
      sun.updateMatrixWorld()
    },
    dispose: () => {
      scene.remove(sun)
      scene.remove(ambient)
      scene.remove(hemi)
      sun.shadow.dispose()
    },
  }
}

/**
 * 大气透视。
 *
 * 密度必须显著低于地球场景：指数 0.0003 时 1 km 距离上雾化量约 9%，
 * 仅使远处山脊略微融入天空，地平线仍保持清晰，符合火星实际能见度。
 * 若按地球经验取 0.002，1 km 外将完全被雾吞没，与火星事实不符。
 */
export function createFog(scene: THREE.Scene): THREE.FogExp2 {
  const fog = new THREE.FogExp2(LIGHTING_PRESET.fogColor, 0.0003)
  scene.fog = fog
  return fog
}