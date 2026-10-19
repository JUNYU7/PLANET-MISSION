import * as THREE from 'three'
import type { HeightField } from '../types'

/**
 * 由高程场构建地形几何体。
 *
 * 不使用顶点位移贴图（displacementMap）：位移贴图通过纹理采样实现，
 * 而 WebGL 纹理为 8 位通道，16 位高程图会被截断至 8 位，1 km 区域
 * 高差 70 m 时量化步长达 0.28 m，接近导航容差的一半。此外位移贴图
 * 无法在 CPU 端精确计算顶点法线。
 *
 * 这里直接在 CPU 端写入 position 属性，好处是：
 *   1. 高程为 Float32，与导出至仿真后端的数据同源，视觉与物理一致
 *   2. 法线由 computeVertexNormals 精确计算，纹理光照表现正确
 *   3. 免除位移缩放与偏移参数的配置困扰
 *
 * 轴向约定：+X 为东，+Y 为上，+Z 为南。栅格 row0 在北，故 j 递增
 * （北→南）时 Z 递增，与 heightAt 的索引顺序一致。
 */
export function buildTerrainGeometry(
  hf: HeightField,
  exaggeration = 1,
): THREE.BufferGeometry {
  const { data, n, size } = hf
  const positions = new Float32Array(n * n * 3)
  const uvs = new Float32Array(n * n * 2)
  const half = size / 2

  for (let j = 0; j < n; j++) {
    const v = j / (n - 1)
    const z = v * size - half
    for (let i = 0; i < n; i++) {
      const k = j * n + i
      const u = i / (n - 1)
      positions[k * 3] = u * size - half
      positions[k * 3 + 1] = data[k] * exaggeration
      positions[k * 3 + 2] = z
      uvs[k * 2] = u
      uvs[k * 2 + 1] = 1 - v
    }
  }

  // 必须显式建立索引缓冲。若省略，three.js 会按每三个顶点凑一个三角形，
  // 使 513² 个顶点形成跨整行的狭长三角形，几何形状完全错乱，
  // 表现为「地形不可见且不报错」。
  //
  // 顶点绕序为 (a, c, b) 与 (b, c, d)：X 随 i 递增、Z 随 j 递增，
  // 该顺序使叉积指向 +Y，法线朝上。若取 (a, b, c) 则法线朝下，
  // 配合默认 FrontSide 剔除同样会导致地形不可见。
  const quads = (n - 1) * (n - 1)
  const indices = n * n > 65535 ? new Uint32Array(quads * 6)
    : new Uint16Array(quads * 6)
  let p = 0
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i
      const b = a + 1
      const c = a + n
      const d = c + 1
      indices[p++] = a
      indices[p++] = c
      indices[p++] = b
      indices[p++] = b
      indices[p++] = c
      indices[p++] = d
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geo.setIndex(new THREE.BufferAttribute(indices, 1))
  geo.computeVertexNormals()
  geo.computeBoundingSphere()
  return geo
}

/**
 * 创建地形材质。
 *
 * 色彩空间是关键：正射影像是视觉数据，用 SRGBColorSpace；
 * 数据类图层（坡度、曲率、可通行性、语义）必须用 NoColorSpace，
 * 否则会被施加伽马变换，视觉上尚可但数值解读结果错误。
 */
export function buildTerrainMaterial(
  map: THREE.Texture,
  colorSpace: 'srgb' | 'none',
  anisotropy: number,
): THREE.MeshStandardMaterial {
  map.colorSpace = colorSpace === 'srgb' ? THREE.SRGBColorSpace : THREE.NoColorSpace
  map.anisotropy = anisotropy
  map.minFilter = THREE.LinearMipmapLinearFilter
  map.magFilter = THREE.LinearFilter
  map.generateMipmaps = true
  map.wrapS = THREE.ClampToEdgeWrapping
  map.wrapT = THREE.ClampToEdgeWrapping
  map.needsUpdate = true

  return new THREE.MeshStandardMaterial({
    map,
    roughness: 0.96,
    metalness: 0.0,
    dithering: true,
  })
}

/** 加载单张图层纹理并按清单设置色彩空间。 */
export function loadLayerTexture(
  url: string,
  colorSpace: 'srgb' | 'none',
  anisotropy: number,
): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(
      url,
      (tex) => {
        tex.colorSpace =
          colorSpace === 'srgb' ? THREE.SRGBColorSpace : THREE.NoColorSpace
        tex.anisotropy = anisotropy
        tex.minFilter = THREE.LinearMipmapLinearFilter
        tex.magFilter = THREE.LinearFilter
        tex.generateMipmaps = true
        tex.wrapS = THREE.ClampToEdgeWrapping
        tex.wrapT = THREE.ClampToEdgeWrapping
        tex.needsUpdate = true
        resolve(tex)
      },
      undefined,
      () => {
        console.error('纹理加载失败', url)
        reject(new Error(`纹理加载失败：${url}`))
      },
    )
  })
}