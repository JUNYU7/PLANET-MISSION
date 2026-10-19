import * as THREE from 'three'
import type { HeightField, MissionActivity, MissionTarget } from '../types'
import { heightAt } from './heightField'

/**
 * 任务标记（策划书 28.4 场景标注构建）。
 *
 * 按任务类型差异化样式（用户要求，不再统一使用立柱+圆环）：
 * - TRAVERSE          立柱 + 贴地圆环 + 序号标签，途经点间用地形跟随折线连接
 * - TARGETED_APPROACH 目标点用立柱+圆环（青），朝向点用八面体（橙）+ 目标→朝向连线
 * - SURVEY_PATH       三个顶点用球体 + 序号标签，顶点围成半透明蓝色三角面，
 *                     质心用金色球体标注，每个顶点朝质心张开 FOV 成像扇面
 *
 * 坐标约定：任务 JSON 的 (x, y) 为世界坐标（x 东、y 南），
 * 前端场景为 (x, z)，z 轴向南，因此直接映射；高度取 y 轴。
 */

export const MARKER_COLOR = 0x00e5ff
export const SELECTED_COLOR = 0xffd60a
export const ORIENT_COLOR = 0xffa500
export const CENTROID_COLOR = 0xffd60a
const SURVEY_FACE_COLOR = 0x3399ff

/** 连线/三角面等面状标注的悬空高度（米）：脱离地形表面，避免接触 */
const HOVER_M = 25
const SURVEY_SECTOR_COLOR = 0x33ccff

export interface TaskMarkerGroup {
  group: THREE.Group
  dispose: () => void
}

interface Ctx {
  group: THREE.Group
  disposables: Array<{ dispose: () => void }>
  hf: HeightField
  exag: number
  opacity: number
  color: number
  actId: string
}

function groundY(hf: HeightField, x: number, z: number, exag: number): number {
  const g = heightAt(hf, x, z, exag)
  return g === -9999 ? 0 : g
}

/** 标签画布纹理（V4 28.3 序号标签实现） */
function makeLabelSprite(text: string, color = '#00E5FF'): THREE.Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 128
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = 'rgba(0,0,0,0.72)'
  ctx.beginPath()
  ctx.roundRect(8, 20, 240, 88, 12)
  ctx.fill()
  ctx.strokeStyle = color
  ctx.lineWidth = 4
  ctx.stroke()
  ctx.fillStyle = color
  ctx.font = 'bold 56px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 128, 64)

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }),
  )
  sprite.scale.set(16, 8, 1)
  return sprite
}

function addMesh(ctx: Ctx, geo: THREE.BufferGeometry, y: number, x: number, z: number) {
  const mat = new THREE.MeshBasicMaterial({
    color: ctx.color,
    transparent: true,
    opacity: ctx.opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  ctx.disposables.push(geo, mat)
  const mesh = new THREE.Mesh(geo, mat)
  mesh.position.set(x, y, z)
  mesh.userData.activityId = ctx.actId
  ctx.group.add(mesh)
  return mesh
}

function addLabel(ctx: Ctx, text: string, color: string, y: number, x: number, z: number) {
  const sprite = makeLabelSprite(text, color)
  ;(sprite.material as THREE.SpriteMaterial).opacity = ctx.opacity
  sprite.position.set(x, y, z)
  sprite.userData.activityId = ctx.actId
  ctx.disposables.push(sprite.material.map as THREE.Texture, sprite.material)
  ctx.group.add(sprite)
}

/** 立柱 + 贴地圆环 + 标签（TRAVERSE 途经点 / TARGETED 目标点 / SURVEY 顶点）
 *
 * 样式约束（实测反馈「圆环像障碍物挡住了火星车」）：标记是纯前端
 * 可视层，后端物理只认越界/坡度/巨石三项，标记从不参与碰撞。但原先
 * 半径 5.5–7 m 的不透明贴地圆环 + 14 m 实心立柱在视觉上等同于一堵
 * 墙，会误导判读。因此改为「细描边圆环 + 半透明细立柱」：一眼可辨
 * 是标注而非实体，同时保留一定的点击选取面积。
 */
function addPillarTarget(ctx: Ctx, t: MissionTarget, label: string,
                        labelColor?: string) {
  const gy = groundY(ctx.hf, t.x, t.y, ctx.exag)
  const savedOpacity = ctx.opacity
  // 立柱/圆环额外淡化：避免遮挡火星车、避免被误读为实体障碍
  ctx.opacity = savedOpacity * 0.5
  const pillarGeo = new THREE.CylinderGeometry(0.4, 0.4, 8, 10)
  // 细描边圆环（3.0–3.4 m）：读作标注圈，而非围墙
  const ringGeo = new THREE.RingGeometry(3.0, 3.4, 40)
  addMesh(ctx, pillarGeo, gy + 4, t.x, t.y)
  const ring = addMesh(ctx, ringGeo, gy + 0.25, t.x, t.y)
  ring.rotation.x = -Math.PI / 2
  ctx.opacity = savedOpacity
  addLabel(ctx, label,
    labelColor ?? (ctx.color === SELECTED_COLOR ? '#FFD60A' : '#00E5FF'),
    gy + 9.5, t.x, t.y)
}

/** 途经点连线（TRAVERSE）：悬空绘制——每段高度取两端点地面高程的
 *  最大值加 HOVER_M，段内线性插值，保证整条线不接触地形表面 */
function addPathLine(ctx: Ctx, pts: MissionTarget[]) {
  if (pts.length < 2) return
  const positions: number[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const segs = 16
    const hover =
      Math.max(
        groundY(ctx.hf, a.x, a.y, ctx.exag),
        groundY(ctx.hf, b.x, b.y, ctx.exag),
      ) + HOVER_M
    for (let s = 0; s < segs; s++) {
      const t0 = s / segs
      const t1 = (s + 1) / segs
      const ax = a.x + (b.x - a.x) * t0
      const az = a.y + (b.y - a.y) * t0
      const bx = a.x + (b.x - a.x) * t1
      const bz = a.y + (b.y - a.y) * t1
      positions.push(ax, hover, az)
      positions.push(bx, hover, bz)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  const mat = new THREE.LineBasicMaterial({
    color: ctx.color,
    transparent: true,
    opacity: Math.min(ctx.opacity + 0.15, 1),
  })
  ctx.disposables.push(geo, mat)
  const line = new THREE.Line(geo, mat)
  line.userData.activityId = ctx.actId
  ctx.group.add(line)
}

/** 朝向点：八面体 + 目标→朝向连线（与目标点性质区分）。
 *  连线与八面体悬空于 HOVER_M 高度（取两端点地面高程最大值），不接触地形 */
function addOrientationMarker(ctx: Ctx, from: MissionTarget, to: MissionTarget) {
  const color = ctx.color === SELECTED_COLOR ? SELECTED_COLOR : ORIENT_COLOR
  const hover =
    Math.max(
      groundY(ctx.hf, from.x, from.y, ctx.exag),
      groundY(ctx.hf, to.x, to.y, ctx.exag),
    ) + HOVER_M

  const geo = new THREE.OctahedronGeometry(2.6)
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: Math.min(ctx.opacity + 0.15, 1),
    depthWrite: false,
  })
  ctx.disposables.push(geo, mat)
  const mesh = new THREE.Mesh(geo, mat)
  mesh.position.set(to.x, hover, to.y)
  mesh.userData.activityId = ctx.actId
  ctx.group.add(mesh)

  // 目标 → 朝向 指示线（悬空）
  const lgeo = new THREE.BufferGeometry()
  lgeo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [from.x, hover, from.y, to.x, hover, to.y],
      3,
    ),
  )
  const lmat = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.9,
  })
  ctx.disposables.push(lgeo, lmat)
  const line = new THREE.Line(lgeo, lmat)
  line.userData.activityId = ctx.actId
  ctx.group.add(line)

  addLabel(ctx, '朝向', color === SELECTED_COLOR ? '#FFD60A' : '#FFA500',
    hover + 6, to.x, to.y)
}

/** 成像扇面：顶点处朝质心方向、孔径 fov 的水平扇形 */
function addSector(
  ctx: Ctx,
  ox: number,
  oy: number,
  oz: number,
  towardX: number,
  towardZ: number,
  fovDeg: number,
  radius: number,
) {
  const baseAngle = Math.atan2(towardZ - oz, towardX - ox)
  const half = (fovDeg * Math.PI) / 180 / 2
  const segs = 20
  const positions: number[] = []
  for (let s = 0; s < segs; s++) {
    const a0 = baseAngle - half + (2 * half * s) / segs
    const a1 = baseAngle - half + (2 * half * (s + 1)) / segs
    positions.push(ox, oy, oz)
    positions.push(ox + radius * Math.cos(a0), oy, oz + radius * Math.sin(a0))
    positions.push(ox + radius * Math.cos(a1), oy, oz + radius * Math.sin(a1))
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  const mat = new THREE.MeshBasicMaterial({
    color: SURVEY_SECTOR_COLOR,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  ctx.disposables.push(geo, mat)
  const mesh = new THREE.Mesh(geo, mat)
  mesh.userData.activityId = ctx.actId
  ctx.group.add(mesh)
}

function buildTraverse(ctx: Ctx, act: MissionActivity) {
  act.targets.forEach((t, i) => {
    addPillarTarget(ctx, t, String(i + 1))
  })
  addPathLine(ctx, act.targets)
}

function buildTargeted(ctx: Ctx, act: MissionActivity) {
  const target = act.targets.find((t) => t.role !== 'orientation')
  const orient = act.targets.find((t) => t.role === 'orientation')
  if (target) addPillarTarget(ctx, target, '目标')
  if (target && orient) addOrientationMarker(ctx, target, orient)
}

function buildSurvey(ctx: Ctx, act: MissionActivity) {
  const verts = act.targets.filter((t) => t.role === 'vertex')
  const centroid = act.targets.find((t) => t.role === 'centroid')
  const fov = act.fov ?? 60

  // 悬空平面高度：三角面与成像扇面位于该平面，不接触地形；
  // 顶点/质心标记与其他任务一致贴地（立柱 + 圆环）
  const hover =
    Math.max(...verts.map((v) => groundY(ctx.hf, v.x, v.y, ctx.exag))) +
    HOVER_M

  // 半透明蓝色三角面（悬空平面）
  if (verts.length === 3) {
    const pos: number[] = []
    verts.forEach((v) => {
      pos.push(v.x, hover, v.y)
    })
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    const mat = new THREE.MeshBasicMaterial({
      color: SURVEY_FACE_COLOR,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    ctx.disposables.push(geo, mat)
    const face = new THREE.Mesh(geo, mat)
    face.userData.activityId = ctx.actId
    ctx.group.add(face)
  }

  // 顶点：贴地立柱 + 序号标签（与途经点/目标点一致）；
  // 朝质心的成像扇面仍从悬空平面发出
  verts.forEach((v, i) => {
    addPillarTarget(ctx, v, String(i + 1))
    if (centroid) {
      addSector(ctx, v.x, hover, v.y, centroid.x, centroid.y, fov, 90)
    }
  })

  // 质心：贴地金色立柱 + 标签
  if (centroid) {
    const saved = ctx.color
    ctx.color = CENTROID_COLOR
    addPillarTarget(ctx, centroid, '质心', '#FFD60A')
    ctx.color = saved
  }
}

/** 由活动列表构建任务标记组；selectedId 非空时其余标记淡化 */
export function createTaskMarkers(
  hf: HeightField,
  exag: number,
  activities: MissionActivity[],
  selectedId: string | null,
): TaskMarkerGroup {
  const group = new THREE.Group()
  const disposables: Array<{ dispose: () => void }> = []

  activities.forEach((act, idx) => {
    if (act.targets.length === 0) return
    const selected = act.id === selectedId
    const ctx: Ctx = {
      group,
      disposables,
      hf,
      exag,
      opacity: selectedId === null ? 0.85 : selected ? 1.0 : 0.3,
      color: selected ? SELECTED_COLOR : MARKER_COLOR,
      actId: act.id,
    }
    if (act.type === 'TRAVERSE') buildTraverse(ctx, act)
    else if (act.type === 'TARGETED_APPROACH') buildTargeted(ctx, act)
    else if (act.type === 'SURVEY_PATH') buildSurvey(ctx, act)
    else buildTraverse(ctx, act)
    void idx
  })

  return {
    group,
    dispose: () => {
      disposables.forEach((d) => d.dispose())
    },
  }
}
