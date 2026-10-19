import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { heightAt } from './heightField'
import type { HeightField } from '../types'

/**
 * 火星巡视器模型（仿 NASA 毅力号 Perseverance 造型）。
 *
 * 结构：楔形船体（侧剖轮廓挤出：斜切鼻锥 + 收腰车尾 + 内缩上甲板，
 * 而非规则长方体）+ 金色多层隔热贴片 + 尾部 RTG（散热鳍片）+
 * 桅杆双目相机（Mastcam-Z 风格，带镜筒环与双镜头基线杆）+
 * 6 轮铝制车轮（防滑筋 + 轮面减压孔）+ 两连杆悬挂 IK 贴地+
 * 侧壁折叠机械臂 + 甲板高增益天线 + 前后 Hazard 相机 + 侧板太阳能阵列
 * + 车身编号标识（两侧船体后段 + 上甲板顶面）。车头灯为真实 SpotLight。
 *
 * 尺度（V4 实测反馈「车比石头还小」后对齐真实火星车）：
 * 全长≈3.2 m、含板全宽≈2.9 m、桅杆顶≈2.15 m、轮径 0.52 m。此前车体
 * 仅 0.88 m 宽、轮径 0.56 m（轮径÷车宽 64%，像玩具车），而语义
 * 栅格一格 1.95 m、可碾碎石的隆起普遍 <0.5 m——小车比石头还窄，
 * 与「碎石可直接碾过」的物理自相矛盾。现按毅力号 3.0×2.7×2.2 m
 * 重标定，比例与地形要素、照片相机高度（2.15 m）一并对齐。
 *
 * 历史问题（本版已修复）：
 * - 反馈「太宽」：太阳能板外飘到 |z|=1.92 m，全宽 3.9 m 比车长 3.2 m
 *   还宽，显臃肿。现车体宽 1.9→1.66 m（侧面收进轮内缘）、板内缘贴到
 *   船体侧面并把板宽 1.0→0.6 m，全宽收到≈2.9 m，长宽比≈1.1:1。
 * - 太阳能板横跨船体侧面，把车身编号压在下缘看不见。现面板抬到
 *   y=1.14 m（船体侧面编号区仅 0.55~0.88 m），编号在侧视/俯视均无遮挡。
 * - 车体是规则长方体，剪影平淡。现改为侧剖轮廓挤出 + 分层堆叠。
 * - SpotLight 的 target 默认在场景原点，灯光实际朝车体后方照射；
 *   现显式设置 target 于车前，并加入场景图。
 * - 车轮圆柱轴向为 Y（立着的“硬币”）且自转绕 Y（螺旋桨式）；
 *   现轴向 Z（轮轴横向）、自转绕 Z（正确滚动）。
 *
 * 朝向约定：模型局部 +X 为车头。外部以世界 yaw（atan2(dy, dx)，
 * x 东、y 南）放置，group.rotation.y = -yaw。
 */

export interface RoverRig {
  group: THREE.Group
  /** 放置到地形（x 东、y 南、yaw 世界朝向），悬挂 IK 贴地 */
  setPose(x: number, y: number, yaw: number, hf: HeightField, exag: number): void
  /** 线速度（m/s）驱动轮转与差速 */
  setSpeed(v: number, dt: number): void
  /** 灯带呼吸 / 扫描环 / beacon / 全息环（t 为秒） */
  updateFx(t: number): void
  dispose(): void
}

// ---- 尺度常量（米，对齐毅力号）----
const WHEEL_R = 0.26 // 轮半径（轮径 0.52 m，同毅力号）
const BODY_L = 2.9 // 车体长
const BODY_W = 1.66 // 车体宽（收窄后：侧面落在轮内缘之内，剪影修长）
const HULL_H = 0.52 // 挤出船体侧剖高度（鼻锥斜切后的平直段）
const HULL_Y = 0.45 // 船体底面离地（离地间隙 0.45 m）
const BODY_HALF_W = BODY_W / 2 // 车体半宽 0.83
const HULL_SIDE = BODY_HALF_W + 0.035 // 船体侧面外缘（含倒角）0.865
const DECK_W = BODY_W - 0.38 // 上甲板宽（两侧较船体内收，形成台阶）
const DECK_TOP = 1.25 // 上甲板顶面（桅杆/设备/天线安装基准）
const NOSE_Y = 0.6 // 车头/车尾立面附件（Hazard 相机、车头灯）安装高度
const LINK1 = 0.62 // 悬挂上臂长
const LINK2 = 0.62 // 悬挂前臂长
const MOUNT_Y = 0.8 // 悬挂上车点高度（船体侧面中部）
const MAST_X = 0.62 // 桅杆前后位置（上甲板前区）
const HEAD_Y = 1.95 // 桅杆相机头中心高度（≈ 拍照相机高度）
const BEACON_Y = 2.14 // 桅杆顶 beacon
// 太阳能板：从船体侧面向外伸出（内缘≈侧面外缘），不再外飘
const PANEL_Z = 1.1 // 板中心横向位置 → 外缘 1.42 m
const PANEL_Y = 1.14 // 太阳能板高度（明确高于侧标，视线不遮挡）
const PANEL_L = 2.0 // 板长（沿车体轴向）
const PANEL_D = 0.6 // 板宽（沿横向）
const PANEL_TIP = PANEL_Z + PANEL_D / 2 - 0.12 // 斜撑外端落点（板外半部下方）

/** 轮位（局部坐标，车头 +X）：前 / 中 / 后 × 左右（rocker-bogie 式） */
const WHEEL_LAYOUT: Array<[number, number]> = [
  [1.35, 1.06], [1.35, -1.06],
  [0.0, 1.1], [0.0, -1.1],
  [-1.35, 1.06], [-1.35, -1.06],
]

interface Wheel {
  pivot: THREE.Group
  spin: THREE.Group
  /** 轮心相对车体中心的安装偏移（未随 yaw 旋转） */
  local: THREE.Vector3
  /** 悬挂上车点（车体局部坐标） */
  mount: THREE.Vector3
  /** 当前悬挂臂几何（每帧重建，dispose 时统一释放） */
  armGeos: THREE.BufferGeometry[]
}

/** 两连杆 IK：由根 A 与轮心 W 解肘关节 E（取上方解，弯曲在 XY 平面） */
function solveElbow(a: THREE.Vector3, w: THREE.Vector3): THREE.Vector3 {
  const d = new THREE.Vector3().subVectors(w, a)
  const dist = d.length()
  const n = d.clone().normalize()
  const aCoef = (dist * dist + LINK1 * LINK1 - LINK2 * LINK2) / (2 * dist)
  const hSq = LINK1 * LINK1 - aCoef * aCoef
  const h = Math.sqrt(Math.max(hSq, 0))
  const base = a.clone().addScaledVector(n, aCoef)
  // 垂直方向：在 X-Y 平面内绕 Z 轴转 90°
  const perp = new THREE.Vector3(-n.y, n.x, 0).normalize()
  return base.addScaledVector(perp, h)
}

/** 两点之间的连杆（盒体），沿 Y 缩放到长度后定向 */
function strut(
  a: THREE.Vector3,
  b: THREE.Vector3,
  thickness: number,
  material: THREE.Material,
): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(b, a)
  const len = dir.length()
  const geo = new THREE.BoxGeometry(thickness, len, thickness)
  const mesh = new THREE.Mesh(geo, material)
  mesh.position.copy(a).addScaledVector(dir, 0.5)
  mesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    dir.normalize(),
  )
  return mesh
}

/** 构建单只车轮：铝件（轮辋 + 防滑筋）与深色件（轮毂 + 减压孔）
 *  分别合并为单一几何体，每轮仅 2 个 draw call。轮盘位于 XY 平面、
 *  轮轴沿 Z（横向），与滚动方向一致。 */
function buildWheel(): { alum: THREE.BufferGeometry; dark: THREE.BufferGeometry } {
  const alum: THREE.BufferGeometry[] = []
  const dark: THREE.BufferGeometry[] = []
  const W = 0.34 // 轮宽

  // 轮辋（铝）
  const rim = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, W, 30)
  rim.rotateX(Math.PI / 2) // 轴向 Y → Z
  alum.push(rim)

  // 防滑筋：24 根直筋，奇偶轻微错角（仿毅力号辐条轮筋）
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2
    const cleat = new THREE.BoxGeometry(0.09, 0.045, W - 0.02)
    cleat.rotateZ(a + (i % 2 === 0 ? 0.1 : -0.1))
    cleat.translate(
      Math.cos(a) * (WHEEL_R - 0.01),
      Math.sin(a) * (WHEEL_R - 0.01),
      0,
    )
    alum.push(cleat)
  }

  // 轮面减压孔（双面各 7 个，深色）
  for (const side of [1, -1] as const) {
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + 0.26
      const hole = new THREE.CircleGeometry(0.045, 12)
      if (side < 0) hole.rotateY(Math.PI) // 背面朝外
      hole.translate(
        Math.cos(a) * 0.175,
        Math.sin(a) * 0.175,
        (side * W) / 2 + 0.001,
      )
      dark.push(hole)
    }
  }

  // 轮毂（深色）
  const hub = new THREE.CylinderGeometry(0.1, 0.1, W + 0.04, 16)
  hub.rotateX(Math.PI / 2)
  dark.push(hub)

  const alumGeo = mergeGeometries(alum)
  const darkGeo = mergeGeometries(dark)
  if (!alumGeo || !darkGeo) {
    // 合并失败时退回未合并几何体（理论上不会发生）
    return {
      alum: alum[0] ?? new THREE.BufferGeometry(),
      dark: dark[0] ?? new THREE.BufferGeometry(),
    }
  }
  return { alum: alumGeo, dark: darkGeo }
}

/** 车身编号标识贴图（Canvas 纹理）：远处也能辨认是哪台车 */
function makeDecalTexture(): THREE.CanvasTexture {
  const w = 512
  const h = 160
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = 'rgba(0,0,0,0)'
  ctx.fillRect(0, 0, w, h)

  // 左侧：任务标识徽章（同心圆 + 十字星，仿行星探测器徽标）
  ctx.strokeStyle = '#1B4FA8'
  ctx.lineWidth = 7
  ctx.beginPath()
  ctx.arc(74, h / 2, 48, 0, Math.PI * 2)
  ctx.stroke()
  ctx.strokeStyle = '#C9A24B'
  ctx.lineWidth = 5
  ctx.beginPath()
  ctx.arc(74, h / 2, 33, 0, Math.PI * 2)
  ctx.stroke()
  ctx.strokeStyle = '#1B4FA8'
  ctx.lineWidth = 6
  ctx.beginPath()
  ctx.moveTo(74, h / 2 - 44)
  ctx.lineTo(74, h / 2 + 44)
  ctx.moveTo(28, h / 2)
  ctx.lineTo(120, h / 2)
  ctx.stroke()

  // 右侧：编号与名称
  ctx.fillStyle = '#12325F'
  ctx.font = 'bold 62px sans-serif'
  ctx.textBaseline = 'middle'
  ctx.fillText('PM-1', 148, h / 2 - 4)
  ctx.fillStyle = '#3C4A5E'
  ctx.font = '30px sans-serif'
  ctx.fillText('PLANET MISSION', 152, h / 2 + 44)

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

export function createRover(): RoverRig {
  const group = new THREE.Group()
  const geos: THREE.BufferGeometry[] = []
  const mats: THREE.Material[] = []
  const texs: THREE.Texture[] = []

  const track = <T extends THREE.BufferGeometry>(g: T): T => {
    geos.push(g)
    return g
  }
  const trackMat = <T extends THREE.Material>(m: T): T => {
    mats.push(m)
    return m
  }

  // ---- 材质（毅力号配色：暖白车体 / 金色 MLI / 铝 / 深色机构）----
  const bodyMat = trackMat(new THREE.MeshStandardMaterial({
    color: 0xd6d1c4, roughness: 0.55, metalness: 0.15,
  }))
  const grayMat = trackMat(new THREE.MeshStandardMaterial({
    color: 0x8f959d, roughness: 0.5, metalness: 0.3,
  }))
  // 注意：场景无环境贴图，高金属度材质会因无反射内容而近黑，
  // 故铝/金的 metalness 控制在 0.35~0.4，靠漫反射呈现金属灰/金
  const alumMat = trackMat(new THREE.MeshStandardMaterial({
    color: 0xb9bec6, roughness: 0.5, metalness: 0.4,
  }))
  const goldMat = trackMat(new THREE.MeshStandardMaterial({
    color: 0xc9a24b, roughness: 0.45, metalness: 0.35,
  }))
  const darkMat = trackMat(new THREE.MeshStandardMaterial({
    color: 0x23262b, roughness: 0.6, metalness: 0.3,
  }))
  const lensMat = trackMat(new THREE.MeshStandardMaterial({
    color: 0x0c0e12, roughness: 0.15, metalness: 0.9,
  }))
  const amberMat = trackMat(new THREE.MeshStandardMaterial({
    color: 0x2a1a08, emissive: 0xffb060, emissiveIntensity: 2.0,
  }))
  const beaconMat = trackMat(new THREE.MeshStandardMaterial({
    color: 0x200008, emissive: 0xff2d20, emissiveIntensity: 0.3,
  }))
  const dishMat = trackMat(new THREE.MeshStandardMaterial({
    color: 0xcfd3d8, roughness: 0.4, metalness: 0.4,
    side: THREE.DoubleSide,
  }))
  // 太阳能电池板：深蓝硅片 + 银色边框
  const cellMat = trackMat(new THREE.MeshStandardMaterial({
    color: 0x16255c, roughness: 0.35, metalness: 0.35,
    emissive: 0x0a1330, emissiveIntensity: 0.4,
  }))
  const frameMat = trackMat(new THREE.MeshStandardMaterial({
    color: 0xa8aeb6, roughness: 0.45, metalness: 0.4,
  }))

  /** 放置一个盒体（自动纳入释放追踪） */
  const box = (
    w: number, h: number, d: number,
    x: number, y: number, z: number,
    mat: THREE.Material, rounded = false,
  ): THREE.Mesh => {
    const geo = rounded
      ? track(new RoundedBoxGeometry(w, h, d, 3, 0.05))
      : track(new THREE.BoxGeometry(w, h, d))
    const m = new THREE.Mesh(geo, mat)
    m.position.set(x, y, z)
    group.add(m)
    return m
  }

  /** 两点之间的杆件（自动纳入释放追踪），用于太阳能板斜撑等结构件 */
  const rod = (
    a: THREE.Vector3,
    b: THREE.Vector3,
    thickness: number,
    mat: THREE.Material,
  ): THREE.Mesh => {
    const m = strut(a, b, thickness, mat)
    geos.push(m.geometry)
    group.add(m)
    return m
  }

  // ---- 车体：侧剖轮廓挤出（不再是规则长方体）----
  // 侧视轮廓：平直底部 → 头部斜切鼻锥 → 平直顶甲板 → 尾部斜切收腰。
  // 一次挤出即得到楔形车头与收腰车尾（规则长方体做不到的剪影），
  // 再叠加内缩上甲板形成台阶层次。
  const hullShape = new THREE.Shape()
  hullShape.moveTo(-BODY_L / 2, 0.0)
  hullShape.lineTo(BODY_L / 2, 0.0)
  hullShape.lineTo(BODY_L / 2, 0.3) // 头部前沿（最前）
  hullShape.lineTo(BODY_L / 2 - 0.34, HULL_H) // 斜切鼻锥
  hullShape.lineTo(-BODY_L / 2 + 0.2, HULL_H) // 平直顶甲板
  hullShape.lineTo(-BODY_L / 2, HULL_H - 0.16) // 尾部斜切收腰
  hullShape.lineTo(-BODY_L / 2, 0.0)
  const hullGeo = track(new THREE.ExtrudeGeometry(hullShape, {
    depth: BODY_W,
    bevelEnabled: true,
    bevelSize: 0.035,
    bevelThickness: 0.035,
    bevelSegments: 2,
  }))
  hullGeo.translate(0, 0, -BODY_W / 2)
  const hull = new THREE.Mesh(hullGeo, bodyMat)
  hull.position.y = HULL_Y
  group.add(hull)

  // 上甲板：较船体内缩前后与两侧，形成台阶
  box(1.95, DECK_TOP - (HULL_Y + HULL_H), DECK_W, -0.2,
    (HULL_Y + HULL_H + DECK_TOP) / 2, 0, bodyMat, true)

  // 腹部防撞梁（深色，斜面护板）
  box(2.5, 0.12, BODY_W - 0.18, 0, HULL_Y + 0.05, 0, darkMat)

  // 轮罩：每侧三片，覆于各轮上方（深灰，斜掠造型）
  for (const [wx] of WHEEL_LAYOUT.filter((_, i) => i % 2 === 0)) {
    for (const sz of [1, -1]) {
      const fender = box(0.9, 0.07, 0.4, wx, 0.62, sz * 1.06, grayMat)
      fender.rotation.x = sz * -0.07
    }
  }

  // ---- 金色多层隔热（MLI）贴片：只贴左侧前段，避开侧标与右侧机械臂 ----
  box(1.25, 0.3, 0.02, 0.4, 0.7, -(HULL_SIDE + 0.008), goldMat)

  // ---- 甲板设备盒（顶面落在 DECK_TOP）----
  box(0.45, 0.16, 0.4, -0.9, DECK_TOP + 0.08, 0.4, grayMat)
  box(0.36, 0.14, 0.4, 0.55, DECK_TOP + 0.07, -0.4, grayMat)

  // ---- 桅杆 + Mastcam-Z 双目相机头（镜筒环 + 双镜头基线杆）----
  const mastH = HEAD_Y - 0.13 - DECK_TOP // 桅杆杆体高度
  box(0.12, mastH, 0.12, MAST_X, DECK_TOP + mastH / 2, 0, grayMat)
  box(0.44, 0.26, 0.4, MAST_X, HEAD_Y, 0, bodyMat, true)

  const HEAD_X = MAST_X + 0.22 // 相机头前表面
  // 双镜头基线杆（横跨两个镜筒，远景更立体）
  box(0.06, 0.06, 0.3, HEAD_X - 0.04, HEAD_Y, 0, alumMat)
  for (const sz of [0.12, -0.12]) {
    // 镜筒（轴向 X）
    const camGeo = track(new THREE.CylinderGeometry(0.075, 0.075, 0.22, 16))
    camGeo.rotateZ(Math.PI / 2)
    camGeo.translate(HEAD_X + 0.11, HEAD_Y, sz)
    group.add(new THREE.Mesh(camGeo, grayMat))
    // 镜筒环（前后两道铝环，强化立体感）
    for (const [rx, rr] of [[0.04, 0.092], [0.19, 0.086]] as const) {
      const ringGeo = track(new THREE.CylinderGeometry(rr, rr, 0.035, 16))
      ringGeo.rotateZ(Math.PI / 2)
      ringGeo.translate(HEAD_X + rx, HEAD_Y, sz)
      group.add(new THREE.Mesh(ringGeo, alumMat))
    }
    // 镜头（朝前）
    const lensGeo = track(new THREE.CircleGeometry(0.062, 14))
    lensGeo.rotateY(Math.PI / 2)
    lensGeo.translate(HEAD_X + 0.222, HEAD_Y, sz)
    group.add(new THREE.Mesh(lensGeo, lensMat))
    // 基线杆端帽
    box(0.06, 0.06, 0.05, HEAD_X - 0.04, HEAD_Y, sz, alumMat)
  }

  // 桅杆顶 beacon（小尺寸，便于在远景中定位小车）
  const beaconGeo = track(new THREE.SphereGeometry(0.03, 12, 8))
  beaconGeo.translate(MAST_X, BEACON_Y, 0)
  group.add(new THREE.Mesh(beaconGeo, beaconMat))

  // ---- RTG（尾部左侧，金色圆柱 + 散热鳍片，轻微上翘）----
  // 基准改为尾部斜切面：x=-1.32 处船体顶面约 0.91 m，故基座取 0.86 嵌入
  const rtg = new THREE.Group()
  rtg.position.set(-1.32, 0.86, -0.5)
  rtg.rotation.z = 0.14
  const rtgPost = track(new THREE.BoxGeometry(0.24, 0.3, 0.24))
  rtgPost.translate(0, 0.15, 0)
  rtg.add(new THREE.Mesh(rtgPost, grayMat))
  const rtgBody = track(new THREE.CylinderGeometry(0.14, 0.14, 0.85, 18))
  rtgBody.rotateZ(Math.PI / 2)
  rtgBody.translate(-0.28, 0.38, 0)
  rtg.add(new THREE.Mesh(rtgBody, goldMat))
  for (let i = 0; i < 5; i++) {
    const fin = track(new THREE.CylinderGeometry(0.175, 0.175, 0.022, 18))
    fin.rotateZ(Math.PI / 2)
    fin.translate(-0.62 + i * 0.19, 0.38, 0)
    rtg.add(new THREE.Mesh(fin, darkMat))
  }
  group.add(rtg)

  // ---- 高增益天线（上甲板顶面，碟形碗口朝上）----
  const dishPost = track(new THREE.CylinderGeometry(0.026, 0.026, 0.22, 10))
  dishPost.translate(0.05, DECK_TOP + 0.11, 0.38)
  group.add(new THREE.Mesh(dishPost, grayMat))
  const dishGeo = track(new THREE.SphereGeometry(0.22, 20, 10, 0, Math.PI * 2, 0, Math.PI / 3))
  dishGeo.translate(0.05, DECK_TOP + 0.22, 0.38)
  group.add(new THREE.Mesh(dishGeo, dishMat))
  const feedGeo = track(new THREE.CylinderGeometry(0.03, 0.03, 0.07, 8))
  feedGeo.translate(0.05, DECK_TOP + 0.27, 0.38)
  group.add(new THREE.Mesh(feedGeo, darkMat))

  // ---- 折叠机械臂（右侧壁下缘，收拢态；让开侧标与太阳能板）----
  box(0.22, 0.22, 0.22, 1.02, 0.78, 0.95, grayMat) // 肩关节
  const upperArm = box(0.9, 0.1, 0.1, 0.8, 0.836, 0.95, bodyMat)
  upperArm.rotation.z = 2.9 // 由肩向后上方展开
  const foreArm = box(0.62, 0.09, 0.09, 0.434, 0.838, 0.95, bodyMat)
  foreArm.rotation.z = 3.5 // 前臂回折向下
  box(0.17, 0.17, 0.17, 0.23, 0.77, 0.95, grayMat) // 末端 turret
  box(0.07, 0.2, 0.07, 0.13, 0.75, 0.9, grayMat) // 指节
  box(0.07, 0.2, 0.07, 0.13, 0.75, 1.0, grayMat)

  // ---- 侧板太阳能阵列（两侧各一片，深蓝电池 + 银框 + 斜撑）----
  // 关键：面板内缘≈船体侧面（0.80 vs 0.865），不再向外飘，
  // 全宽收到≈2.9 m（原来 3.9 m，比车长还宽）；同时高度 1.14 m
  // 高于船体侧面 0.55~0.88 的编号区，侧视/俯视均不遮挡编号。
  for (const sz of [1, -1]) {
    const tilt = sz > 0 ? -0.12 : 0.12 // 外缘抬高
    // 电池板本体
    const panel = box(PANEL_L, 0.045, PANEL_D, -0.25, PANEL_Y, sz * PANEL_Z, cellMat)
    panel.rotation.x = tilt
    // 银色边框
    const frame = box(PANEL_L + 0.08, 0.06, PANEL_D + 0.08, -0.25,
      PANEL_Y - 0.03, sz * PANEL_Z, frameMat)
    frame.rotation.x = tilt
    // 电池片分格线（3 条纵向），增强「电池阵列」辨识度
    for (let i = 1; i <= 3; i++) {
      const strip = box(0.04, 0.05, PANEL_D + 0.02,
        -0.25 - PANEL_L / 2 + i * (PANEL_L / 4), PANEL_Y + 0.02, sz * PANEL_Z, frameMat)
      strip.rotation.x = tilt
    }
    // 斜撑：船体侧面 → 板外半部下方（自轮罩上方掠过，不穿轮）
    for (const bx of [0.45, -0.95]) {
      rod(new THREE.Vector3(bx, 0.88, sz * HULL_SIDE),
        new THREE.Vector3(bx, PANEL_Y - 0.07, sz * PANEL_TIP),
        0.05, grayMat)
    }
  }

  // ---- 车身编号标识（两侧船体后段 + 上甲板顶面，远处均可辨认）----
  const decalTex = makeDecalTexture()
  texs.push(decalTex)
  const decalMat = trackMat(new THREE.MeshBasicMaterial({
    map: decalTex,
    transparent: true,
    depthWrite: false,
  }))
  // 贴图 512×160（3.2:1），按比例给宽高
  for (const sz of [1, -1]) {
    const dGeo = track(new THREE.PlaneGeometry(0.95, 0.95 / 3.2))
    const decal = new THREE.Mesh(dGeo, decalMat)
    decal.position.set(-0.72, 0.71, sz * (HULL_SIDE + 0.012))
    if (sz < 0) decal.rotation.y = Math.PI
    group.add(decal)
  }
  {
    // 上甲板顶面平贴一块，俯视时最清晰
    const dGeo = track(new THREE.PlaneGeometry(1.25, 1.25 / 3.2))
    const decal = new THREE.Mesh(dGeo, decalMat)
    decal.rotation.x = -Math.PI / 2
    decal.position.set(-0.45, DECK_TOP + 0.012, -0.05)
    group.add(decal)
  }

  // ---- Hazard 相机（前后各两枚，装在前后立面 NOSE_Y 高度）----
  for (const sz of [0.42, -0.42]) {
    box(0.07, 0.11, 0.17, 1.5, NOSE_Y, sz, darkMat)
    const fl = track(new THREE.CircleGeometry(0.035, 10))
    fl.rotateY(Math.PI / 2)
    fl.translate(1.545, NOSE_Y, sz)
    group.add(new THREE.Mesh(fl, lensMat))
    box(0.07, 0.11, 0.17, -1.5, NOSE_Y, sz, darkMat)
    const rl = track(new THREE.CircleGeometry(0.035, 10))
    rl.rotateY(-Math.PI / 2)
    rl.translate(-1.545, NOSE_Y, sz)
    group.add(new THREE.Mesh(rl, lensMat))
  }

  // ---- 车头灯（amber 灯罩 + SpotLight，target 显式指向前方）----
  for (const sz of [0.66, -0.66]) {
    const lampGeo = track(new THREE.CylinderGeometry(0.055, 0.055, 0.05, 14))
    lampGeo.rotateZ(Math.PI / 2)
    lampGeo.translate(1.5, NOSE_Y + 0.06, sz)
    group.add(new THREE.Mesh(lampGeo, amberMat))
    const spot = new THREE.SpotLight(0xffc078, 14, 45, 0.5, 0.5, 1.2)
    spot.position.set(1.5, NOSE_Y + 0.06, sz)
    // 关键：SpotLight 默认照向场景原点（车体后方），此处显式
    // 将 target 放到车前 5 m，并加入场景图使其世界矩阵生效。
    spot.target.position.set(5, 0.1, sz)
    group.add(spot.target)
    group.add(spot)
  }

  // ---- 悬挂 + 车轮 ----
  const wheels: Wheel[] = []
  const wheelGeo = buildWheel()
  geos.push(wheelGeo.alum, wheelGeo.dark)
  const _zero = new THREE.Vector3(0, 0, 0)
  for (const [wx, wz] of WHEEL_LAYOUT) {
    const mount = new THREE.Vector3(wx * 0.68, MOUNT_Y, wz)
    const pivot = new THREE.Group()
    pivot.position.copy(mount)

    // 两段悬挂臂（初始沿 Y，IK 每帧重算）；坐标为 pivot 局部
    const arm1 = strut(_zero, new THREE.Vector3(0, 0.45, 0), 0.05, grayMat)
    const arm2 = strut(new THREE.Vector3(0, 0.45, 0), _zero.clone(), 0.046, grayMat)
    pivot.add(arm1, arm2)
    ;(pivot as unknown as { __arms: THREE.Mesh[] }).__arms = [arm1, arm2]

    // 轮组（自转）：轮盘在 XY 平面、轮轴 Z，滚动为绕 Z 旋转
    const spin = new THREE.Group()
    spin.add(
      new THREE.Mesh(wheelGeo.alum, alumMat),
      new THREE.Mesh(wheelGeo.dark, darkMat),
    )
    pivot.add(spin)
    group.add(pivot)
    wheels.push({
      pivot, spin,
      local: new THREE.Vector3(wx, 0, wz),
      mount,
      armGeos: [arm1.geometry, arm2.geometry],
    })
  }

  const _v = new THREE.Vector3()
  const _e = new THREE.Vector3()
  const _a = new THREE.Vector3()
  const _d = new THREE.Vector3()

  let spinPhase = 0

  return {
    group,

    setPose(x, y, yaw, hf, exag) {
      const groundC = heightAt(hf, x, y, exag)
      // x/z 必须随位姿更新：否则车体钉在原地、只有高度变化，
      // 表现为「小车在地下不动」（历史 bug）。
      group.position.set(x, groundC === -9999 ? 0 : groundC, y)
      group.rotation.y = -yaw

      const cos = Math.cos(yaw)
      const sin = Math.sin(yaw)
      const reach = LINK1 + LINK2 - 0.12

      for (const w of wheels) {
        // 轮心世界坐标（安装偏移随 yaw 旋转）→ 地形高度
        const wx = x + w.local.x * cos - w.local.z * sin
        const wz = y + w.local.x * sin + w.local.z * cos
        const g = heightAt(hf, wx, wz, exag)
        const ground = (g === -9999 ? 0 : g) + WHEEL_R
        // 轮心局部 Y 限制在连杆可达范围内（陡坡下悬挂会“打满”）
        const want = ground - group.position.y
        const wheelY = Math.max(-reach, Math.min(reach, want))

        // 轮心（pivot 局部坐标）
        _v.set(
          w.local.x - w.mount.x,
          wheelY - MOUNT_Y,
          w.local.z - w.mount.z,
        )
        w.spin.position.set(0, _v.y, _v.z)

        _e.copy(solveElbow(_zero, _v))
        const arms = (w.pivot as unknown as {
          __arms: THREE.Mesh[]
        }).__arms
        if (arms && arms.length === 2) {
          // 释放上帧几何，重建当前帧连杆
          arms[0].geometry.dispose()
          arms[1].geometry.dispose()
          arms[0].geometry = new THREE.BoxGeometry(
            0.05, _zero.distanceTo(_e), 0.05)
          arms[1].geometry = new THREE.BoxGeometry(
            0.046, _e.distanceTo(_v), 0.046)
          w.armGeos = [arms[0].geometry, arms[1].geometry]
          _d.subVectors(_e, _zero)
          arms[0].position.copy(_zero).addScaledVector(_d, 0.5)
          arms[0].quaternion.setFromUnitVectors(
            _a.set(0, 1, 0), _d.normalize())
          _d.subVectors(_v, _e)
          arms[1].position.copy(_e).addScaledVector(_d, 0.5)
          arms[1].quaternion.setFromUnitVectors(
            _a.set(0, 1, 0), _d.normalize())
        }
      }
    },

    setSpeed(v, dt) {
      spinPhase += (v / WHEEL_R) * dt
      // 轮盘在 XY 平面、轮轴 Z：滚动 = 绕 Z 旋转
      for (const w of wheels) w.spin.rotation.z = -spinPhase
    },

    updateFx(t) {
      // 保留桅杆顶 beacon 呼吸（远景中用于定位小车）
      beaconMat.emissiveIntensity = Math.sin(t * 6) > 0 ? 2.2 : 0.25
    },

    dispose() {
      for (const g of geos) g.dispose()
      for (const m of mats) m.dispose()
      for (const tx of texs) tx.dispose()
      for (const w of wheels) {
        for (const g of w.armGeos) g.dispose()
      }
    },
  }
}