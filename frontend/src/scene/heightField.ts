import type { HeightField } from '../types'

export const OUT_OF_BOUNDS = -9999

/**
 * 双线性插值查询任意世界坐标处的地面高度。
 *
 * 坐标约定：+X 为东，+Y 为上，+Z 为南。高程场row0 在北侧，
 * 因此 Z 由北向南递增，与 v = z / size + 0.5 的索引顺序一致。
 *
 * 不用射线求交：百万顶点网格上逐帧 raycast 会明显掉帧，且交点精度受
 * 三角面插值限制。双线性插值是 1 m 栅格的分段线性延拓，属该栅格的
 * 正确数学表示，不引入振荡，且每帧开销可忽略。
 *
 * 附带收益：此处使用的高程与导出至仿真后端的数据同源，因此网页上
 * 漫游看到的高度与仿真环境中一致。
 *
 * exaggeration 为垂直夸张系数。实测该区域 1 km 内高差仅 70.6 m，而
 * 火星车眼高约 2 m，纯真实比例下地形在第一人称视角中显得极矮小，
 * 缺乏尺度参照。行星地理学制图普遍用垂直夸张恢复尺度感（NASA 火星
 * 地形图常用 2–5 倍），此处将其作为可调参数，并同步作用于网格构建与
 * 高度查询，保证渲染与漫游一致。该系数仅影响显示，不影响任何指标计算。
 */
export function heightAt(
  hf: HeightField,
  x: number,
  z: number,
  exaggeration = 1,
): number {
  const { data, n, size } = hf
  const u = x / size + 0.5
  const v = z / size + 0.5
  if (u < 0 || u > 1 || v < 0 || v > 1) return OUT_OF_BOUNDS

  const fx = u * (n - 1)
  const fz = v * (n - 1)
  const i0 = Math.floor(fx)
  const j0 = Math.floor(fz)
  const i1 = Math.min(i0 + 1, n - 1)
  const j1 = Math.min(j0 + 1, n - 1)
  const tx = fx - i0
  const tz = fz - j0

  const h00 = data[j0 * n + i0]
  const h10 = data[j0 * n + i1]
  const h01 = data[j1 * n + i0]
  const h11 = data[j1 * n + i1]

  const h =
    (h00 * (1 - tx) + h10 * tx) * (1 - tz) +
    (h01 * (1 - tx) + h11 * tx) * tz

  return exaggeration === 1 ? h : h * exaggeration
}

/** 世界坐标是否落在场景范围内。 */
export function inBounds(hf: HeightField, x: number, z: number): boolean {
  const half = hf.size / 2
  return x >= -half && x <= half && z >= -half && z <= half
}

/**
 * 由东西向与南北向中心剖线各采样一条高程曲线，用于右栏剖面图。
 * 返回长度为 count 的归一化曲线（0~1）与实际高程数组。
 */
export function sampleProfiles(
  hf: HeightField,
  count = 128,
): { east: number[]; north: number[]; min: number; max: number } {
  const half = hf.size / 2
  const east: number[] = []
  const north: number[] = []
  let min = Infinity
  let max = -Infinity

  for (let k = 0; k < count; k++) {
    const t = (k / (count - 1)) * hf.size - half
    const he = heightAt(hf, t, 0)
    const hn = heightAt(hf, 0, t)
    east.push(he)
    north.push(hn)
    if (he !== OUT_OF_BOUNDS) {
      if (he < min) min = he
      if (he > max) max = he
    }
    if (hn !== OUT_OF_BOUNDS) {
      if (hn < min) min = hn
      if (hn > max) max = hn
    }
  }

  if (!isFinite(min)) {
    min = 0
    max = 1
  }
  if (max <= min) max = min + 1

  return { east, north, min, max }
}