import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import {
  fetchHeightField,
  layerUrl,
  rocksUrl,
  setLiveRoverSpeed,
  startLiveRun,
  terrainQuery,
} from '../api/client'
import EventLog from '../components/EventLog'
import StatusBar from '../components/StatusBar'
import InfoPanel from '../components/InfoPanel'
import TaskPanel from '../components/TaskPanel'
import TelemetryPanel from '../components/TelemetryPanel'
import PhotoPanel from '../components/PhotoPanel'
import RadarScanWindow, { type RadarScanHandle } from '../components/RadarScanWindow'
import { logEvent } from '../console/events'
import { createTaskMarkers, type TaskMarkerGroup } from '../scene/TaskMarkers'
import { createRover, type RoverRig } from '../scene/RoverModel'
import { LIGHTING_PRESET, createFog, createLighting } from '../scene/Lighting'
import {
  MARS_SKY_PRESET,
  createSkyDome,
  sunAltitude,
  sunDirection,
} from '../scene/SkyDome'
import { buildTerrainGeometry, loadLayerTexture } from '../scene/TerrainMesh'
import { MINIMAP_PRESET, createMinimap } from '../scene/Minimap'
import {
  DUST_PRESET_CAPTURE,
  DUST_PRESET_INTERACTIVE,
  createDustField,
} from '../scene/DustField'
import { heightAt, sampleProfiles } from '../scene/heightField'
import type { ActivityType, CapturedPhoto, LiveDone, LiveFrame, Mission, MissionActivity, PhotoEvent, TerrainProbe } from '../types'
import {
  createFirstPerson,
  type FirstPersonController,
} from '../controls/FirstPersonController'
import {
  VIEW_PRESETS,
  installCapture,
  removeCapture,
  type CaptureView,
} from '../../tools/capture'
import { useApp } from '../store/AppContext'
import type { HeightField, LayerId } from '../types'

/** 天空球半径（米）。固定值，须小于相机远裁剪面。 */
const SKY_RADIUS = 6000

/** 实时仿真相机跟随的最大观察距离（米）：超出后温和收回，
 *  避免小车缩成一点、看不到火星车。 */
const LIVE_FOLLOW_MAX_DIST = 150

/** 跟随距离约束用的临时向量（避免每帧分配） */
const _followOffset = new THREE.Vector3()

/**
 * 由高程场差分求车体姿态：地形法线（供陀螺仪定向）与俯仰/横滚
 * （供数字读数）。与渲染地形完全同源（同一 heightAt + 夸张系数），
 * 因此陀螺仪所见即渲染所见。俯仰 + 为车头上仰；横滚为右侧坡向。
 */
function terrainAttitude(
  hf: HeightField,
  x: number,
  y: number,
  yaw: number,
  exag: number,
): { pitch: number; roll: number; normal: { x: number; y: number; z: number } } | null {
  const d = 1.5
  const h0 = heightAt(hf, x, y, exag)
  if (h0 === -9999) return null
  const hx = heightAt(hf, x + d, y, exag)
  const hz = heightAt(hf, x, y + d, exag)
  if (hx === -9999 || hz === -9999) return null
  const gx = (hx - h0) / d // 东向梯度
  const gz = (hz - h0) / d // 南向梯度
  const fx = Math.cos(yaw)
  const fz = Math.sin(yaw)
  return {
    pitch: Math.atan(gx * fx + gz * fz),
    roll: Math.atan(gx * -fz + gz * fx),
    normal: (() => {
      const len = Math.hypot(gx, 1, gz)
      return { x: -gx / len, y: 1 / len, z: -gz / len }
    })(),
  }
}

/**
 * 射线与高程场求交（地形探针用）：沿视线步进找「视点高于地面 →
 * 低于地面」的符号翻转再二分。不用 three.js Raycaster——百万级
 * 三角形的逐帧求交会卡死，而对 heightAt 步进每次仅数百次插值。
 */
function raycastTerrain(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  hf: HeightField,
  exag: number,
): { x: number; z: number; h: number } | null {
  const half = hf.size / 2
  const step = Math.max(hf.size / 400, 2)
  const at = (t: number) => {
    const px = origin.x + dir.x * t
    const pz = origin.z + dir.z * t
    const g = heightAt(hf, px, pz, exag)
    return { px, pz, py: origin.y + dir.y * t, g }
  }
  let prev = at(0)
  if (prev.g !== -9999 && prev.py - prev.g < 0) return null // 起点已在地下
  for (let t = step; t < hf.size * 1.6; t += step) {
    const cur = at(t)
    if (cur.g === -9999) {
      if (Math.abs(cur.px) > half * 1.5 && Math.abs(cur.pz) > half * 1.5) break
      prev = cur
      continue
    }
    const dyPrev = prev.g === -9999 ? 1 : prev.py - prev.g
    const dy = cur.py - cur.g
    if (dyPrev > 0 && dy <= 0) {
      // 二分细化到 0.5 m
      let lo = t - step
      let hi = t
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2
        const m = at(mid)
        const dym = m.g === -9999 ? 1 : m.py - m.g
        if (dym > 0) lo = mid
        else hi = mid
      }
      const hit = at((lo + hi) / 2)
      if (hit.g === -9999) return null
      return { x: hit.px, z: hit.pz, h: hit.g }
    }
    prev = cur
  }
  return null
}

/** 小型确定性随机数（mulberry32）：岩石轮廓库按形状索引生成，跨会话一致 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** rocks.json 中的单块岩石参数（与后端 core/rocks.py 的实例清单一致） */
interface RockInstance {
  id: number
  x: number
  y: number
  r: number
  h: number
  rho: number
  theta: number
  shape: number
}

/** 岩石轮廓库大小：每种轮廓一个 InstancedMesh，实例按 shape 字段分配 */
const ROCK_SHAPES = 8

/**
 * 生成一块棱角分明的岩石基础网格（低多边形 + 平直着色）：
 * 二十面体（1/4 概率用更粗的 20 面体）逐顶点做大幅度径向抖动，
 * 底部拉毛到 [0, 0.18] 的不平整埋入线——岩石因此不是悬空
 * 的椭球，而是嵌进地表的碎岩块。同一 shapeIdx 永远得到同一轮廓。
 */
function makeRockGeometry(shapeIdx: number): THREE.BufferGeometry {
  const rng = mulberry32(0x9e3779b9 + shapeIdx * 7919)
  // 两种细分：粗（20 面，大块岩）与细（80 面，碎石）
  const geo = shapeIdx % 4 === 0
    ? new THREE.IcosahedronGeometry(0.5, 0)
    : new THREE.IcosahedronGeometry(0.5, 1)
  const pos = geo.attributes.position as THREE.BufferAttribute
  const v = new THREE.Vector3()
  // 每形状 3 个随机方向的大幅径向扰动（棱角来自大幅度+低面数）
  const terms = Array.from({ length: 3 }, () => ({
    dx: rng() * 2 - 1,
    dy: rng() * 2 - 1,
    dz: rng() * 2 - 1,
    f: 0.8 + rng() * 1.6,
    a: 0.18 + rng() * 0.22,
    ph: rng() * Math.PI * 2,
  }))
  // 整体轴各向异性：压扁/拉长，进一步打破对称
  const ax = 0.75 + rng() * 0.5
  const ay = 0.7 + rng() * 0.5
  const az = 0.75 + rng() * 0.5
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize()
    let rad = 1
    for (const t of terms) {
      rad += t.a * Math.sin(t.f * (v.x * t.dx + v.y * t.dy + v.z * t.dz) + t.ph)
    }
    v.multiplyScalar(0.5 * Math.max(rad, 0.55))
    v.x *= ax
    v.y *= ay
    v.z *= az
    // 底部拉毛：下 1/4 顶点压到 [0, 0.18]，埋入线不平整
    if (v.y < -0.12) v.y = rng() * 0.18
    else if (v.y < 0) v.y = 0
    pos.setXYZ(i, v.x, v.y, v.z)
  }
  geo.computeVertexNormals()
  return geo
}

/**
 * 把 rocks.json 实例清单放入场景：8 种棱角轮廓各一个 InstancedMesh。
 * 每实例按 (x, y) 放置并**下沉 0.35h 嵌入地形**（底部在地表以下，
 * 避免悬空），缩放/旋转取自后端实例参数，与高度场 bump、贴图明暗
 * 同源。高度按夸张系数同步放大。
 */
function buildRockGroup(
  rocks: RockInstance[],
  hf: HeightField,
  exag: number,
): { group: THREE.Group; dispose: () => void } {
  const group = new THREE.Group()
  const byShape: RockInstance[][] = Array.from(
    { length: ROCK_SHAPES },
    () => [],
  )
  for (const rk of rocks) {
    byShape[rk.shape % ROCK_SHAPES].push(rk)
  }
  const geometries: THREE.BufferGeometry[] = []
  const material = new THREE.MeshStandardMaterial({
    roughness: 0.98,
    metalness: 0,
    flatShading: true, // 平直着色：低面数棱角分明
    // 与地表暖色调一致的灰褐色，每实例再微幅抖动
    color: 0x9a8574,
  })
  const yAxis = new THREE.Vector3(0, 1, 0)
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const p = new THREE.Vector3()
  const s = new THREE.Vector3()
  const col = new THREE.Color()
  for (let shape = 0; shape < ROCK_SHAPES; shape++) {
    const list = byShape[shape]
    if (list.length === 0) continue
    const geo = makeRockGeometry(shape)
    geometries.push(geo)
    const mesh = new THREE.InstancedMesh(geo, material, list.length)
    mesh.castShadow = true
    mesh.receiveShadow = true
    for (let i = 0; i < list.length; i++) {
      const rk = list[i]
      const gy = heightAt(hf, rk.x, rk.y, exag)
      const base = gy === -9999 ? 0 : gy
      const sy = rk.h * exag
      // 下沉 0.35h：底部埋入地表，露出 0.65h（与高度场 bump 同高）
      p.set(rk.x, base - sy * 0.35, rk.y)
      q.setFromAxisAngle(yAxis, -rk.theta)
      s.set(rk.r * rk.rho, sy, rk.r / rk.rho)
      m.compose(p, q, s)
      mesh.setMatrixAt(i, m)
      // 颜色在灰褐色系内按实例 id 抖动，避免整片岩石一个色
      const jitter = ((rk.id * 2654435761) % 1000) / 1000
      col.setHSL(0.07 + jitter * 0.02, 0.12 + jitter * 0.08, 0.42 + jitter * 0.1)
      mesh.setColorAt(i, col)
    }
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    group.add(mesh)
  }
  return {
    group,
    dispose: () => {
      geometries.forEach((g) => g.dispose())
      material.dispose()
    },
  }
}

export default function RegionView() {
  const mountRef = useRef<HTMLDivElement | null>(null)
  const textureCache = useRef(new Map<string, THREE.Texture>())
  const setSunDir = useRef<((d: THREE.Vector3) => void) | null>(null)
  const materialRef = useRef<THREE.MeshStandardMaterial | null>(null)
  const normalTexRef = useRef<THREE.Texture | null>(null)
  const roughnessTexRef = useRef<THREE.Texture | null>(null)
  const fpRef = useRef<FirstPersonController | null>(null)

  const {
    region,
    tier,
    layers,
    layerOpacity,
    localHour,
    exaggeration,
    showGrid,
    setFps,
    planning,
  } = useApp()

  // 垂直夸张系数供漫游控制器在运行时读取，避免系数变化时重建控制器
  const exagRef = useRef(exaggeration)
  exagRef.current = exaggeration
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fpMode, setFpMode] = useState<'ground' | 'fly' | null>(null)
  const [res, setRes] = useState<{ w: number; h: number } | null>(null)
  const [hud, setHud] = useState({ x: 0, z: 0, h: 0 })

  // ---- 任务规划状态（第 28.2 节）----
  // 活动列表是 React state（跨场景重建存活），标记组由 effect 重建。
  // 场景内部对象（mesh/scene/controls 等）经 ref 供点击处理器访问，
  // 处理器闭包只读 ref，避免 effect 依赖问题。
  const [activities, setActivities] = useState<MissionActivity[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [missionName, setMissionName] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  /** 放置类型：先选类型再标记（用户规则），面板单选驱动 */
  const [placementType, setPlacementType] = useState<ActivityType>('TRAVERSE')
  const idCounter = useRef(0)

  const meshRef = useRef<THREE.Mesh | null>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const hfRef = useRef<HeightField | null>(null)
  const taskMarkersRef = useRef<TaskMarkerGroup | null>(null)
  const planningRef = useRef(planning)
  const activitiesRef = useRef(activities)
  const placementRef = useRef(placementType)
  const regionNameRef = useRef('')
  const resizeRef = useRef<(() => void) | null>(null)
  // 拖拽检测：OrbitControls 旋转结束也会触发 click，
  // 记录 mousedown 位置，位移超阈值视为拖拽而非放置点击
  const dragStartRef = useRef<{ x: number; y: number } | null>(null)
  planningRef.current = planning
  activitiesRef.current = activities
  placementRef.current = placementType

  // ---- 实时仿真状态（策划书 20.1：后端 SSE 推流 + 前端定速消费）----
  const [liveActive, setLiveActive] = useState(false)
  const [liveFrame, setLiveFrame] = useState<LiveFrame | null>(null)
  const [liveDone, setLiveDone] = useState<LiveDone | null>(null)
  const [liveError, setLiveError] = useState<string | null>(null)
  /** 火星车速度倍率（v_max × scale），运行期经 live/speed 接口实时调整 */
  const [roverSpeed, setRoverSpeed] = useState(1)
  const [liveFollow, setLiveFollow] = useState(true)

  const liveFramesRef = useRef<LiveFrame[]>([])   // 帧缓冲
  const abortRef = useRef<(() => void) | null>(null)
  const roverRef = useRef<{ rig: RoverRig; scene: THREE.Scene } | null>(null)
  const roverTargetRef = useRef({ x: 0, y: 0, yaw: 0, v: 0 })
  const roverRenderRef = useRef({ x: 0, y: 0, yaw: 0 })
  const trailRef = useRef<{
    line: THREE.Line
    positions: Float32Array
    count: number
  } | null>(null)
  /** 顶点成像照片（SURVEY_PATH）：后端判定拍照成功 → 前端离屏渲染 */
  const [photos, setPhotos] = useState<CapturedPhoto[]>([])
  const photosRef = useRef<CapturedPhoto[]>([])
  /** 雷达成像：主地图扫描区域高亮圆盘（点云在独立 3D 窗口展示） */
  const radarDiscRef = useRef<{
    group: THREE.Group
    scene: THREE.Scene
    mat: THREE.MeshBasicMaterial
    ring: THREE.Line
  } | null>(null)
  /** 雷达点云独立窗口（扫描阶段自动打开，可手动关闭/拖拽） */
  const [radarWinOpen, setRadarWinOpen] = useState(false)
  const radarWinOpenRef = useRef(false)
  const [radarCoverage, setRadarCoverage] = useState(0)
  const radarWinRef = useRef<RadarScanHandle | null>(null)
  /** 漂浮尘埃粒子组（拍照时隐藏：白色圆点会入画） */
  const dustRef = useRef<THREE.Points | null>(null)

  const liveActiveRef = useRef(liveActive)
  const liveFollowRef = useRef(liveFollow)
  liveActiveRef.current = liveActive
  liveFollowRef.current = liveFollow
  /** 首帧到达后用环境真实出生点校正一次相机位姿 */
  const liveSnapRef = useRef(false)
  /** SSE 流已正常结束（done）：继续排空帧缓冲，播完再停 */
  const liveEndedRef = useRef(false)
  /** 当前实时仿真的任务 ID（调速接口需要） */
  const liveMissionIdRef = useRef('')
  /** 地形探针：悬停采样读数（右栏「工具」页签展示）。默认关闭，
   *  开启后地图上才出现标记环并开始采样 */
  const [probeEnabled, setProbeEnabled] = useState(false)
  const [probe, setProbe] = useState<TerrainProbe | null>(null)
  const probeEnabledRef = useRef(probeEnabled)
  probeEnabledRef.current = probeEnabled
  const probeMarkerRef = useRef<{
    group: THREE.Group
    scene: THREE.Scene
  } | null>(null)
  const probeQueryAtRef = useRef(0)
  const probeSeqRef = useRef(0)
  /** 上一帧任务进度标签（变化即途经点到达，推送事件流） */
  const prevProgressRef = useRef('')
  /** 规划模式日志去重（effect 会在 ready 翻转时重复执行） */
  const planningLoggedRef = useRef<boolean | null>(null)

  /**
   * 把环绕相机立刻拉到小车附近（后侧上方 3/4 视角），必要时退出
   * 第一人称。实时仿真启动时调用，保证「点击开始仿真即看到车」。
   */
  const snapCameraNearRover = (x: number, y: number, yaw: number) => {
    const camera = cameraRef.current
    const controls = controlsRef.current
    const hf = hfRef.current
    if (!camera || !controls || !hf) return
    const fp = fpRef.current
    if (fp?.isEnabled()) fp.disable()
    const g = heightAt(hf, x, y, exagRef.current)
    const gy = g === -9999 ? 0 : g
    // 车头朝向 (cos yaw, sin yaw)（场景 +X 东、+Z 南）；
    // 机位取后侧方上空，兼顾小车与地形纵深感
    const cx = Math.cos(yaw)
    const cz = Math.sin(yaw)
    const dist = 38
    camera.position.set(
      x + (-cx * 0.74 + cz * 0.67) * dist,
      gy + dist * 0.42,
      y + (-cz * 0.74 - cx * 0.67) * dist,
    )
    controls.target.set(x, gy + 1.5, y)
    controls.update()
  }

  /**
   * 规划模式点击（第 28.2 节）：先射线检测任务标记（选中/取消），
   * 未命中标记且命中地形则放置新目标点——坐标经第 21 章查询接口
   * 自动回填地形属性后写入活动列表。
   */
  const handlePointerDown = (ev: MouseEvent) => {
    dragStartRef.current = { x: ev.clientX, y: ev.clientY }
  }

  const handlePlanningClick = (ev: MouseEvent) => {
    if (!planningRef.current) return
    // 拖拽地图结束时的 click 不算放置操作（规则：拖动观看时
    // 不会在地图上产生任何标记）
    const down = dragStartRef.current
    if (down && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 4) {
      return
    }
    const camera = cameraRef.current
    const mesh = meshRef.current
    if (!camera || !mesh) return
    const canvas = ev.currentTarget as HTMLCanvasElement
    const rect = canvas.getBoundingClientRect()
    const px = ((ev.clientX - rect.left) / rect.width) * 2 - 1
    const py = -((ev.clientY - rect.top) / rect.height) * 2 + 1
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(new THREE.Vector2(px, py), camera)

    const markerGroup = taskMarkersRef.current?.group
    const targets: THREE.Object3D[] = markerGroup ? [markerGroup, mesh] : [mesh]
    const hits = raycaster.intersectObjects(targets, true)
    if (hits.length === 0) return

    const actId = hits[0].object.userData?.activityId as string | undefined
    if (actId) {
      setSelectedId((prev) => (prev === actId ? null : actId))
      return
    }

    const p = hits[0].point
    const hf = hfRef.current
    if (!hf) return
    const half = hf.size / 2
    if (Math.abs(p.x) > half || Math.abs(p.z) > half) return

    const wx = Math.round(p.x * 10) / 10
    const wz = Math.round(p.z * 10) / 10
    void terrainQuery(regionNameRef.current, p.x, p.z)
      .then((tq) => {
        const tqBlock = {
          ti_class: tq.ti_class,
          slope_deg: tq.slope_deg,
          semantic: tq.semantic,
          roughness_m: tq.roughness_m,
        }
        const newId = () => {
          idCounter.current += 1
          return 'a' + idCounter.current
        }
        const acts = activitiesRef.current
        const type = placementRef.current

        // 按类型的放置规则：
        // TRAVERSE  任意多个途经点，追加到最近一个未完成穿越（无则新建）
        // TARGETED  单击即新建（只放 1 个目标点，朝向自动推导）
        // SURVEY    固定 3 顶点（不共线），满 3 点自动补质心并完结
        if (type === 'TRAVERSE') {
          const open = [...acts].reverse().find((a) => a.type === 'TRAVERSE')
          if (open) {
            setActivities((prev) =>
              prev.map((a) =>
                a.id === open.id
                  ? {
                      ...a,
                      targets: [
                        ...a.targets,
                        { x: wx, y: wz, z: tq.z, role: 'target' as const, terrain_query: tqBlock },
                      ],
                    }
                  : a,
              ),
            )
            setSelectedId(open.id)
          } else {
            const act: MissionActivity = {
              id: newId(),
              type,
              targets: [{ x: wx, y: wz, z: tq.z, role: 'target', terrain_query: tqBlock }],
              budget: { time_s: 1800, max_slope_deg: 25 },
            }
            setActivities((prev) => [...prev, act])
            setSelectedId(act.id)
          }
          setSaveError(null)
          return
        }

        if (type === 'TARGETED_APPROACH') {
          // 单点放置：每次点击即新建一个抵近活动（只放目标点）。
          // 车头朝向由后端按缺省规则推导（朝向区域中心）；旧任务
          // 带 orientation 点的仍兼容加载与使用。
          const act: MissionActivity = {
            id: newId(),
            type,
            targets: [{ x: wx, y: wz, z: tq.z, role: 'target', terrain_query: tqBlock }],
            budget: { time_s: 600, max_slope_deg: 25 },
          }
          setActivities((prev) => [...prev, act])
          setSelectedId(act.id)
          setSaveError(null)
          return
        }

        // SURVEY_PATH
        const open = [...acts]
          .reverse()
          .find(
            (a) =>
              a.type === 'SURVEY_PATH' &&
              a.targets.filter((t) => t.role === 'vertex').length < 3,
          )
        if (open) {
          const verts = open.targets.filter((t) => t.role === 'vertex')
          if (verts.length === 2) {
            // 第 3 点：共线校验（有向面积 < 100 m² 视为共线）
            const area2 = Math.abs(
              verts[0].x * (verts[1].y - wz) +
                verts[1].x * (wz - verts[0].y) +
                wx * (verts[0].y - verts[1].y),
            )
            if (area2 < 100) {
              setSaveError('三个顶点近似共线，无法构成勘测区，请换一个位置点击')
              return
            }
            const cx = (verts[0].x + verts[1].x + wx) / 3
            const cy = (verts[0].y + verts[1].y + wz) / 3
            const cz = (verts[0].z + verts[1].z + tq.z) / 3
            setActivities((prev) =>
              prev.map((a) =>
                a.id === open.id
                  ? {
                      ...a,
                      fov: a.fov ?? 60,
                      targets: [
                        ...a.targets,
                        { x: wx, y: wz, z: tq.z, role: 'vertex' as const, terrain_query: tqBlock },
                        {
                          x: Math.round(cx * 10) / 10,
                          y: Math.round(cy * 10) / 10,
                          z: Math.round(cz * 10) / 10,
                          role: 'centroid' as const,
                        },
                      ],
                    }
                  : a,
              ),
            )
            setSelectedId(open.id)
          } else {
            setActivities((prev) =>
              prev.map((a) =>
                a.id === open.id
                  ? {
                      ...a,
                      targets: [
                        ...a.targets,
                        { x: wx, y: wz, z: tq.z, role: 'vertex' as const, terrain_query: tqBlock },
                      ],
                    }
                  : a,
              ),
            )
            setSelectedId(open.id)
          }
          setSaveError(null)
          return
        }

        // 无未完成勘测活动：新建
        const act: MissionActivity = {
          id: newId(),
          type,
          targets: [{ x: wx, y: wz, z: tq.z, role: 'vertex', terrain_query: tqBlock }],
          budget: { time_s: 1200, max_slope_deg: 25 },
          fov: 60,
        }
        setActivities((prev) => [...prev, act])
        setSelectedId(act.id)
        setSaveError(null)
      })
      .catch((e) => console.error('地形查询失败', e))
  }
  const [profiles, setProfiles] = useState<{
    east: number[]
    north: number[]
    min: number
    max: number
  } | null>(null)

  const meta = region?.meta
  const manifest = region && region.manifest[tier]

  // 区域或档位变化时重建场景
  useEffect(() => {
    const mount = mountRef.current
    if (!mount || !region || !manifest) return

    let disposed = false
    setReady(false)
    setError(null)
    setRes(null)

    const run = async () => {
      try {
        const sizeM = manifest.size_m
        // 资产版本号：管线重跑后 generated_at 变化，强制浏览器
        // 重新拉取贴图/高程/岩石清单（资产响应带一小时 max-age）
        const assetV = region.meta.generated_at
        const data = await fetchHeightField(
          region.meta.name,
          manifest.height_file,
          manifest.grid,
          assetV,
        )
        if (disposed) return
        const hf: HeightField = { data, n: manifest.grid, size: sizeM }

        const scene = new THREE.Scene()
        createFog(scene)

        // 默认机位：约 26°俯角的中景视角。该区域 1 km 范围内高差仅约 70 m
// （约 7%），高空俯视会使地形显得完全平坦，贴地视角又缺乏空间感，
// 此俯角兼顾地形起伏判读与场景纵深。
const camera = new THREE.PerspectiveCamera(
          52,
          mount.clientWidth / Math.max(mount.clientHeight, 1),
          0.5,
          12000,
        )
        camera.position.set(sizeM * 0.22, sizeM * 0.145, sizeM * 0.3)

        const renderer = new THREE.WebGLRenderer({ antialias: true })
        // 超采样：标准档 1.25× 起步兼顾集显帧率；高清档 1.5× 起步、
        // 2× 封顶。不用固定 2×：1080p 屏上 2× 等于 4 倍像素量，集显
        // 笔记本会掉帧，而边缘锐度的收益在 1.5× 时已大部分拿到。
        // 屏幕像素比本身已较高时不再额外提升，避免无意义的渲染放大。
        const basePR = Math.min(window.devicePixelRatio || 1, 2)
        renderer.setPixelRatio(
          tier === 'capture'
            ? Math.min(2, Math.max(basePR, 1.5))
            : Math.max(basePR, 1.25),
        )
        renderer.setSize(mount.clientWidth, mount.clientHeight)
        renderer.outputColorSpace = THREE.SRGBColorSpace
        // 不使用 ACES 等电影色调映射：这类映射专为压高光提暗部设计，
        // 会明显降低地表对比度，使起伏平缓的真实地形显得完全平坦。
        // 科学可视化需要保留原始明暗关系，直接输出 sRGB 即可。
        renderer.toneMapping = THREE.NoToneMapping
        renderer.shadowMap.enabled = true
        renderer.shadowMap.type = THREE.PCFSoftShadowMap
        mount.appendChild(renderer.domElement)

        // 天空：半径远大于场景包围盒，随相机平移以避免走出天空
        const sky = createSkyDome({
          ...MARS_SKY_PRESET,
          // 半径固定而非随场景放大：天空球必须完全落在相机远裁剪面内，
          // 否则整个球体会被 far 裁掉，表现为天空全黑。改为固定半径并
          // 让天空球每帧跟随相机位置，任何场景尺寸下都完整可见。
          radius: SKY_RADIUS,
        })
        scene.add(sky.mesh)
        setSunDir.current = sky.setSunDirection

        const lighting = createLighting(scene, {
          ...LIGHTING_PRESET,
          shadowMapSize: tier === 'capture' ? 2048 : 1024,
        })

        const aniso = renderer.capabilities.getMaxAnisotropy()
        const activeLayer = (Object.keys(layers) as LayerId[]).find(
          (id) => layers[id],
        )
        const firstId: LayerId = activeLayer ?? 'color'
        const firstDef = manifest.layers.find((l) => l.id === firstId)
        if (!firstDef || !firstDef.file) {
          throw new Error('未找到可用的图层纹理')
        }
        const baseMap = await loadLayerTexture(
          layerUrl(region.meta.name, firstDef.file, assetV),
          firstDef.color_space,
          aniso,
        )
        if (disposed) {
          baseMap.dispose()
          return
        }
        textureCache.current.set(firstId, baseMap)

        const material = new THREE.MeshStandardMaterial({
          map: baseMap,
          roughness: 0.96,
          metalness: 0,
          dithering: true,
        })
        materialRef.current = material

        // 细节法线贴图：法线是线性数据，必须用 NoColorSpace 加载，
        // 否则会被施加伽马变换，法线方向整体偏暗导致细节反向。
        // 加载失败（旧区域无此文件）时不阻塞场景，退回纯 map 渲染。
        if (manifest.normal_file) {
          try {
            const normalTex = await loadLayerTexture(
              layerUrl(region.meta.name, manifest.normal_file, assetV),
              'none',
              aniso,
            )
            if (disposed) {
              normalTex.dispose()
              return
            }
            normalTexRef.current = normalTex
            material.normalMap = normalTex
            // 法线图按后端 NORMAL_STRENGTH 缩放梯度生成，three.js 直接
            // 消费贴图 xy 分量——strength>1 时光照斜率大于网格几何实际
            // 坡度，低太阳角下背光假陡坎全黑、地表出现黑色斑纹。
            // 此处按 1/strength 缩放回物理一致（历史数据 2.5 → 0.4）。
            const ns = 1.0 / (manifest.normal_strength ?? 2.5)
            material.normalScale.set(ns, ns)
            material.needsUpdate = true
          } catch (e) {
            console.error('法线贴图加载失败', e)
          }
        }

        // 粗糙度图（后端 detail.py 生成，随档位 2048/4096）：
        // 与 material.roughness 相乘，使地表反光随位置变化，
        // 不再是一片均匀哑光。同样是线性数据，走 NoColorSpace。
        try {
          const roughFile = `roughness_${tier === 'capture' ? 4096 : 2048}.png`
          const roughTex = await loadLayerTexture(
            layerUrl(region.meta.name, roughFile, assetV),
            'none',
            aniso,
          )
          if (disposed) {
            roughTex.dispose()
            return
          }
          roughnessTexRef.current = roughTex
          material.roughnessMap = roughTex
          // 贴图值约 0.78–1.0，乘数保持 1.0 让贴图完全决定粗糙度
          material.roughness = 1.0
          material.needsUpdate = true
        } catch {
          /* 旧区域无粗糙度图：保持均匀 roughness 0.96 */
        }

        const geo = buildTerrainGeometry(hf, exaggeration)
        const mesh = new THREE.Mesh(geo, material)
        mesh.receiveShadow = true
        mesh.castShadow = true
        scene.add(mesh)

        // 供规划模式点击处理器访问的场景对象
        meshRef.current = mesh
        sceneRef.current = scene
        hfRef.current = hf
        cameraRef.current = camera
        regionNameRef.current = region.meta.name

        // 程序化岩石场（后端 rocks.json，core/rocks.py 生成）：
        // 8 种轮廓各一个 InstancedMesh，贴于夸张地形之上。
        // 老区域无此文件时静默跳过，不影响地形渲染
        let rockDispose: (() => void) | null = null
        try {
          const rres = await fetch(rocksUrl(region.meta.name, assetV))
          if (rres.ok) {
            const payload = (await rres.json()) as { rocks?: RockInstance[] }
            if (payload.rocks && payload.rocks.length > 0) {
              const rg = buildRockGroup(payload.rocks, hf, exaggeration)
              scene.add(rg.group)
              rockDispose = rg.dispose
            }
          }
        } catch (e) {
          console.error('岩石实例加载失败', e)
        }

        const controls = new OrbitControls(camera, renderer.domElement)
        controls.enableDamping = true
        controls.dampingFactor = 0.08
        controls.target.set(0, sizeM * 0.035, -sizeM * 0.05)
        controls.maxPolarAngle = Math.PI * 0.495
        controlsRef.current = controls

        // 第一人称漫游：与环绕视角互斥，启用时接管相机控制。
        // 进入区域默认即为第一人称（巡视器视角），只有按 V 才切换到
        // 环绕视角；鼠标点击不再切换视角，仅用于重新锁定指针。
        // onViewChange 负责在 V 键切换时同步 OrbitControls 的启用状态，
        // 否则退出第一人称后环绕视角无法拖动。
        const fp = createFirstPerson(
          camera,
          renderer.domElement,
          hf,
          undefined,
          () => exagRef.current,
          () => lighting.sunDirection(),
          (first) => {
            controls.enabled = !first
            setFpMode(first ? fp.getMode() : null)
          },
        )
        fpRef.current = fp
        // 默认第一人称由规划 effect（依赖 ready）接管：
        // 规划模式开启时保持环绕相机，退出规划后自动回到第一人称。
        // 地形探针：悬停采样（视线与高程场求交 + 节流查询），
        // 读数显示在右栏「工具」页签，光标处放置标记环
        const raycaster = new THREE.Raycaster()
        const ndc = new THREE.Vector2()
        const onProbeMove = (ev: MouseEvent) => {
          // 开关关闭：隐藏标记环并停止采样（读数清空由 effect 同步）
          if (!probeEnabledRef.current) {
            const mk = probeMarkerRef.current
            if (mk && mk.scene === scene) mk.group.visible = false
            return
          }
          const rect = renderer.domElement.getBoundingClientRect()
          ndc.set(
            ((ev.clientX - rect.left) / rect.width) * 2 - 1,
            -((ev.clientY - rect.top) / rect.height) * 2 + 1,
          )
          raycaster.setFromCamera(ndc, camera)
          const hit = raycastTerrain(
            raycaster.ray.origin,
            raycaster.ray.direction,
            hf,
            exagRef.current,
          )
          let mk = probeMarkerRef.current
          if (!hit) {
            if (mk && mk.scene === scene) mk.group.visible = false
            return
          }
          if (!mk || mk.scene !== scene) {
            const group = new THREE.Group()
            const ringGeo = new THREE.RingGeometry(0.9, 1.15, 24)
            ringGeo.rotateX(-Math.PI / 2)
            const dotGeo = new THREE.CircleGeometry(0.2, 12)
            dotGeo.rotateX(-Math.PI / 2)
            group.add(
              new THREE.Mesh(
                ringGeo,
                new THREE.MeshBasicMaterial({
                  color: 0xe8613c,
                  transparent: true,
                  opacity: 0.9,
                  depthWrite: false,
                }),
              ),
            )
            group.add(
              new THREE.Mesh(
                dotGeo,
                new THREE.MeshBasicMaterial({
                  color: 0xe8613c,
                  transparent: true,
                  opacity: 0.9,
                  depthWrite: false,
                }),
              ),
            )
            scene.add(group)
            mk = { group, scene }
            probeMarkerRef.current = mk
          }
          mk.group.visible = true
          mk.group.position.set(hit.x, hit.h + 0.3, hit.z)
          // 读数查询节流（~4 Hz），序号守卫防止旧响应覆盖新位置
          const now = performance.now()
          if (now - probeQueryAtRef.current > 250) {
            probeQueryAtRef.current = now
            const seq = ++probeSeqRef.current
            void terrainQuery(regionNameRef.current, hit.x, hit.z)
              .then((tq) => {
                if (seq !== probeSeqRef.current) return
                const tiNames = ['不确定', '可通行', '缓行', '禁行']
                setProbe({
                  x: hit.x,
                  y: hit.z,
                  z: tq.z ?? hit.h,
                  slope_deg: tq.slope_deg,
                  ti: tiNames[tq.ti_class] ?? String(tq.ti_class),
                  semantic: tq.semantic,
                  roughness_m: tq.roughness_m,
                })
              })
              .catch(() => {})
          }
        }
        renderer.domElement.addEventListener('mousemove', onProbeMove)
        renderer.domElement.addEventListener('mousedown', handlePointerDown)
        renderer.domElement.addEventListener('click', handlePlanningClick)

        // 小地图复用主场景纹理实例，仅需一次 GPU 上传
        const minimap = createMinimap(MINIMAP_PRESET)
        minimap.attachTerrain(baseMap, sizeM)

        // 近地漂浮沙尘：辨识度最高的火星视觉元素
        const dust = createDustField(
          tier === 'capture' ? DUST_PRESET_CAPTURE : DUST_PRESET_INTERACTIVE,
        )
        scene.add(dust.points)
        dustRef.current = dust.points

        // 100 m 参照网格：提供距离参照，用于判读地形尺度。
        // 线段贴合地形起伏铺设，避免悬浮在地面之上。
        const gridStep = 100
        const gridLines: number[] = []
        const half = sizeM / 2
        const segs = 64
        for (let g = -half; g <= half + 0.1; g += gridStep) {
          for (let sIdx = 0; sIdx < segs; sIdx++) {
            const t0 = -half + (sIdx / segs) * sizeM
            const t1 = -half + ((sIdx + 1) / segs) * sizeM
            // 南北向线（沿 Z 变化，X 固定）
            gridLines.push(
              g, heightAt(hf, g, t0, exagRef.current), t0,
              g, heightAt(hf, g, t1, exagRef.current), t1,
            )
            // 东西向线（沿 X 变化，Z 固定）
            gridLines.push(
              t0, heightAt(hf, t0, g, exagRef.current), g,
              t1, heightAt(hf, t1, g, exagRef.current), g,
            )
          }
        }
        const gridGeo = new THREE.BufferGeometry()
        gridGeo.setAttribute(
          'position',
          new THREE.Float32BufferAttribute(gridLines, 3),
        )
        const refGrid = new THREE.LineSegments(
          gridGeo,
          new THREE.LineBasicMaterial({
            color: 0x00e5ff,
            transparent: true,
            opacity: 0.22,
          }),
        )
        refGrid.position.y = 0.15
        refGrid.visible = showGrid
        scene.add(refGrid)

        // 记录实际渲染分辨率（画布 CSS 尺寸 × 像素比），供界面直接展示
        setRes({
          w: Math.round(mount.clientWidth * renderer.getPixelRatio()),
          h: Math.round(mount.clientHeight * renderer.getPixelRatio()),
        })

        // 预载其余图层，切换时零等待
        void Promise.all(
          manifest.layers
            .filter((l) => l.file && l.id !== firstId)
            .map(async (l) => {
              const tex = await loadLayerTexture(
                layerUrl(region.meta.name, l.file as string, assetV),
                l.color_space,
                aniso,
              )
              if (!disposed) textureCache.current.set(l.id, tex)
            }),
        ).catch((e) => console.error('图层预载失败', e))

        setProfiles(sampleProfiles(hf, 140))
        setReady(true)
        logEvent(
          'sys',
          `区域 ${region.meta.name} 已载入 · 网格 ${manifest.grid}² · ${tier === 'capture' ? '高清' : '标准'}`,
        )

        let raf = 0
        let frames = 0
        let last = performance.now()
        let fpsMark = last
        let lastHud = 0

        // ---- 顶点成像：以火星车桅杆相机视角离屏渲染一帧 ----
        // 相机位姿来自后端photo_events（x/y/yaw 为火星车位姿，光轴
        // 指向质心）；安装点须在桅杆相机头**之前**：车体按真实火星车
        // 尺度放大到 3.2 m 后，桅杆镜头伸到车头前 1.39 m、镜头高
        // 1.95 m，相机若在其后（0.55 m 前、1.95 m 高）会把自己桅杆
        // 拍进画面。现取车前 1.45 m、高 2.15 m：既高于桅杆顶、又在其
        // 视锥之外。fov 取任务视角。
        // far 必须 ≥ 天空穹顶半径（6000），否则穹顶被裁剪、照片里
        // 天空全黑（主相机 far=12000，与此保持一致）。
        //
        // 拍照时须隐藏场景里的「任务 UI 层」——任务标记立柱（14 m 青色
        // 发光柱就在顶点，遮挡画面）、轨迹尾线、漂浮尘埃（白色圆点）、
        // 雷达扫描圆盘。这些是给用户看的标注，不是相机该拍到的东西。
        const photoCam = new THREE.PerspectiveCamera(60, 4 / 3, 0.05, 12000)
        const capturePhoto = (ev: PhotoEvent): CapturedPhoto | null => {
          const hfCur = hfRef.current
          if (!hfCur) return null
          const exag = exagRef.current
          const ground = (x: number, z: number) => {
            const h = heightAt(hfCur, x, z, exag)
            return h === -9999 ? 0 : h
          }
          const cx = ev.x + Math.cos(ev.yaw) * 1.45
          const cz = ev.y + Math.sin(ev.yaw) * 1.45
          photoCam.fov = ev.fov
          photoCam.aspect = 4 / 3
          photoCam.position.set(cx, ground(cx, cz) + 2.15, cz)
          photoCam.lookAt(
            ev.target_x,
            ground(ev.target_x, ev.target_y) + 0.5,
            ev.target_y,
          )
          photoCam.updateProjectionMatrix()

          // 隐藏任务 UI 层，渲染后恢复
          const markers = taskMarkersRef.current
          const trail = trailRef.current
          const disc = radarDiscRef.current
          const dustGroup = dustRef.current
          const prevVis = [
            markers?.group.visible,
            trail?.line.visible,
            disc?.group.visible,
            dustGroup?.visible,
          ]
          if (markers) markers.group.visible = false
          if (trail) trail.line.visible = false
          if (disc) disc.group.visible = false
          if (dustGroup) dustGroup.visible = false
          renderer.render(scene, photoCam)
          if (markers) markers.group.visible = prevVis[0] ?? true
          if (trail) trail.line.visible = prevVis[1] ?? true
          if (disc) disc.group.visible = prevVis[2] ?? true
          if (dustGroup) dustGroup.visible = prevVis[3] ?? true
          return { ...ev, url: renderer.domElement.toDataURL('image/png') }
        }

        // ---- 雷达成像：主地图只显示扫描区域高亮（点云在独立窗口）----
        // 扫描范围是一个 10 m 半径半透明圆盘（贴在火星车处地面），
        // 起旋/扫描时呼吸闪烁，扫描结束即消失。点云与扫描束在
        // RadarScanWindow 独立 3D 窗口展示。
        const RADAR_DISC_R = 10
        const ensureRadarDisc = (x: number, z: number, groundY: number) => {
          if (radarDiscRef.current && radarDiscRef.current.scene === scene) {
            return radarDiscRef.current
          }
          const group = new THREE.Group()
          const mat = new THREE.MeshBasicMaterial({
            color: 0x00e5ff,
            transparent: true,
            opacity: 0.16,
            depthWrite: false,
            side: THREE.DoubleSide,
          })
          const disc = new THREE.Mesh(
            new THREE.CircleGeometry(RADAR_DISC_R, 72),
            mat,
          )
          disc.rotation.x = -Math.PI / 2 // 平铺（CircleGeometry 默认在 XY 平面）
          group.add(disc)
          // 外圈亮线，勾出扫描边界
          const ringPts: THREE.Vector3[] = []
          for (let i = 0; i <= 72; i++) {
            const a = (i / 72) * Math.PI * 2
            ringPts.push(
              new THREE.Vector3(
                Math.cos(a) * RADAR_DISC_R,
                0,
                Math.sin(a) * RADAR_DISC_R,
              ),
            )
          }
          const ring = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(ringPts),
            new THREE.LineBasicMaterial({
              color: 0x00e5ff,
              transparent: true,
              opacity: 0.7,
            }),
          )
          ring.frustumCulled = false
          group.add(ring)
          group.position.set(x, groundY + 0.25, z)
          scene.add(group)
          radarDiscRef.current = { group, scene, mat, ring }
          return radarDiscRef.current
        }
        const hideRadarDisc = () => {
          const d = radarDiscRef.current
          if (d) d.group.visible = false
        }
        /** 主地图扫描区域高亮：spinup/scan 时显示呼吸圆盘，done 即消失 */
        const updateRadarDisc = (f: LiveFrame) => {
          const hfCur = hfRef.current
          if (!hfCur || !f.radar) return
          const exag = exagRef.current
          const g = heightAt(hfCur, f.x, f.y, exag)
          const base = g === -9999 ? 0 : g
          if (f.radar.phase === 'done') {
            hideRadarDisc()
            return
          }
          const disc = ensureRadarDisc(f.x, f.y, base)
          disc.group.visible = true
          disc.group.position.set(f.x, base + 0.25, f.y)
          // 呼吸闪烁：起旋阶段明显，扫描阶段减弱
          disc.mat.opacity =
            f.radar.phase === 'spinup'
              ? 0.14 + 0.1 * Math.abs(Math.sin(f.t * 3.0))
              : 0.1 + 0.04 * Math.abs(Math.sin(f.t * 3.0))
        }

        // 出图入口：切换机位与预设图层，渲染稳定后返回 dataURL。
        // 供浏览器自动化调用，使出图可重复、可批量。
        installCapture(async (view: CaptureView) => {
          const preset = VIEW_PRESETS[view]
          if (!preset) {
            console.error('未知机位', view)
            return null
          }
          fp.disable()
          controls.enabled = true
          setFpMode(null)

          // 相机与观察点高度：preset.position[1] 为 null 时按该点实际地形
          // 高度加 eyeOffset 推算。不用场景边长的固定比例，因为 2 km 区域
          // 内沙脊起伏可达十余米，固定高度会把相机埋进地形内部。
          const exag = exagRef.current
          const px = preset.position[0] * sizeM
          const pz = preset.position[2] * sizeM
          const tx = preset.target[0] * sizeM
          const tz = preset.target[2] * sizeM
          const groundAt = (x: number, z: number) => {
            const h = heightAt(hf, x, z, exag)
            return h === -9999 ? 0 : h
          }
          camera.fov = preset.fov
          camera.position.set(
            px,
            preset.position[1] === null
              ? groundAt(px, pz) + (preset.eyeOffset ?? 2)
              : preset.position[1] * sizeM,
            pz,
          )
          controls.target.set(
            tx,
            preset.target[1] === null
              ? groundAt(tx, tz) + (preset.targetEyeOffset ?? 1)
              : preset.target[1] * sizeM,
            tz,
          )
          camera.lookAt(controls.target)
          camera.updateProjectionMatrix()
          controls.update()

          const target = preset.layer as LayerId
          const tex = textureCache.current.get(target)
          if (tex) {
            material.map = tex
            material.opacity = 1
            material.transparent = false
            material.needsUpdate = true
          }

          // 等待数帧，确保阴影贴图与纹理状态都已生效
          for (let i = 0; i < 8; i++) {
            await new Promise((r) => requestAnimationFrame(() => r(null)))
          }
          renderer.render(scene, camera)
          return renderer.domElement.toDataURL('image/png')
        })

        const animate = () => {
          raf = requestAnimationFrame(animate)
          const now = performance.now()
          const dt = Math.min((now - last) / 1000, 0.1)
          last = now
          if (fp.isEnabled()) {
            fp.update(dt)
          } else {
            controls.update()
          }

          // 流已结束（done）且帧缓冲排空：实时仿真整体停止，
          // 避免任务结束后小车/轨迹还在动
          if (
            liveEndedRef.current &&
            liveActiveRef.current &&
            liveFramesRef.current.length === 0 &&
            roverRef.current
          ) {
            setLiveActive(false)
          }

          // ---- 实时仿真消费：后端真实 1 倍速推送，前端逐帧应用 ----
          // 无播放倍速：帧到即应用（真实节奏下每动画帧 0~1 帧）；
          // 网络抖动积帧时一次性应用完毕，轨迹逐点记录不跳变。
          const rv = roverRef.current
          if (rv && rv.scene === scene && liveActiveRef.current) {
            while (liveFramesRef.current.length > 0) {
              const f = liveFramesRef.current.shift() as LiveFrame
              roverTargetRef.current = { x: f.x, y: f.y, yaw: f.yaw, v: f.v_actual ?? f.v }
              // 姿态：高程场差分（与渲染同源），附加到帧供陀螺仪与读数
              const att = terrainAttitude(hf, f.x, f.y, f.yaw, exagRef.current)
              // 遥测与地图同步：显示当前播放帧（而非最新收到帧），
              // 否则遥测数字会远快于地图上的小车与轨迹
              setLiveFrame(att ? { ...f, ...att } : f)
              // 事件流：车辆事件（碰撞/滑转/违规…）
              for (const ev of f.events) {
                const ts = `t+${ev.t.toFixed(1)}s`
                if (ev.type === 'collision') logEvent('err', `✗ 碰撞 · ${ts}`)
                else if (ev.type === 'slip') logEvent('warn', `⚠ 滑转 · ${ts}`)
                else if (ev.type === 'slope_violation')
                  logEvent('warn', `⚠ 坡道违规 · ${ts}`)
                else if (ev.type === 'stuck') logEvent('err', `✗ 卡死 · ${ts}`)
                else if (ev.type === 'flip') logEvent('err', `✗ 倾覆 · ${ts}`)
                else if (ev.type === 'scan_start')
                  logEvent('rov', `📡 雷达成像开始 · ${ts}`)
                else if (ev.type === 'radar_deploy')
                  logEvent('rov', `📡 雷达展开起旋 · ${ts}`)
                else if (ev.type === 'scan_complete')
                  logEvent('rov', `✓ 地形扫描完成（360°）· ${ts}`)
                else if (ev.type === 'scan_partial')
                  logEvent('warn', `⚠ 扫描圈数用尽，部分完成 · ${ts}`)
              }
              // 顶点成像：火星车相机视角离屏渲染一帧，入照片墙
              if (f.photo_events && f.photo_events.length > 0) {
                for (const ev of f.photo_events) {
                  const shot = capturePhoto(ev)
                  if (shot) {
                    photosRef.current = [...photosRef.current, shot]
                    setPhotos(photosRef.current)
                    logEvent(
                      'rov',
                      `📷 顶点 ${ev.vertex + 1} 成像 · 光轴指向质点 · t+${ev.t.toFixed(1)}s`,
                    )
                  }
                }
              }
              // 雷达成像：主地图扫描区域高亮 + 独立窗口点云/扫描束
              if (f.radar) {
                updateRadarDisc(f)
                setRadarCoverage(f.radar.coverage)
                if (f.radar.phase !== 'done' && !radarWinOpenRef.current) {
                  // 起旋即打开独立点云窗口（扫描结束保留供查看）
                  radarWinOpenRef.current = true
                  setRadarWinOpen(true)
                }
                if (f.radar.points.length > 0) {
                  radarWinRef.current?.appendPoints(f.radar.points)
                }
                radarWinRef.current?.setSweep(
                  f.radar.angle,
                  f.radar.phase === 'scan',
                )
              }
              // 途经点到达：进度标签变化即推送
              if (f.progress.label !== prevProgressRef.current) {
                if (prevProgressRef.current)
                  logEvent('rov', `途经点到达 · ${f.progress.label}`)
                prevProgressRef.current = f.progress.label
              }
              // 首帧到达：按环境真实出生点校正一次机位（近似出生点
              // 与环境实际出生点可能相差一二十米）
              if (liveSnapRef.current) {
                liveSnapRef.current = false
                snapCameraNearRover(f.x, f.y, f.yaw)
              }
              // 轨迹尾线：帧间隔（0.25s ≈ 1~2 m）内按 ≤0.5 m 分段
              // 插值并逐点采样高程，避免长直线弦切入山体（穿模）
              const tr = trailRef.current
              if (tr && tr.count < 19900) {
                const rt0 = tr.count === 0 ? null : {
                  x: tr.positions[(tr.count - 1) * 3],
                  z: tr.positions[(tr.count - 1) * 3 + 2],
                }
                const exag = exagRef.current
                const dx = rt0 ? f.x - rt0.x : 0
                const dz = rt0 ? f.y - rt0.z : 0
                const dist = Math.hypot(dx, dz)
                const steps = rt0 ? Math.max(1, Math.ceil(dist / 0.5)) : 1
                for (let s = rt0 ? 1 : 0; s <= steps && tr.count < 20000; s++) {
                  const t = s / steps
                  const px = f.x - dx * (1 - t)
                  const pz = f.y - dz * (1 - t)
                  const g = heightAt(hf, px, pz, exag)
                  tr.positions[tr.count * 3] = px
                  tr.positions[tr.count * 3 + 1] =
                    (g === -9999 ? 0 : g) + 0.25
                  tr.positions[tr.count * 3 + 2] = pz
                  tr.count += 1
                }
                tr.line.geometry.setDrawRange(0, tr.count)
                tr.line.geometry.attributes.position.needsUpdate = true
              }
            }
            // 平滑逼近目标位姿（低倍速下也不顿）
            const rt = roverTargetRef.current
            const rr = roverRenderRef.current
            const k = 1 - Math.exp(-dt * 14)
            rr.x += (rt.x - rr.x) * k
            rr.y += (rt.y - rr.y) * k
            let dyaw = rt.yaw - rr.yaw
            while (dyaw > Math.PI) dyaw -= 2 * Math.PI
            while (dyaw < -Math.PI) dyaw += 2 * Math.PI
            rr.yaw += dyaw * k
            rv.rig.setPose(rr.x, rr.y, rr.yaw, hf, exagRef.current)
            rv.rig.setSpeed(rt.v, dt)
            rv.rig.updateFx(now / 1000)
            // 相机跟随（只平移水平位置，保留用户环绕角度）
            if (liveFollowRef.current) {
              const p = rv.rig.group.position
              const dx = p.x - controls.target.x
              const dz = p.z - controls.target.z
              controls.target.x += dx
              controls.target.z += dz
              camera.position.x += dx
              camera.position.z += dz
              // 跟随距离约束：视角拉得过远时小车只剩一个点，温和收回
              _followOffset.subVectors(camera.position, controls.target)
              const d = _followOffset.length()
              if (d > LIVE_FOLLOW_MAX_DIST) {
                const kc = 1 - Math.exp(-dt * 1.5)
                _followOffset.multiplyScalar(
                  (d + (LIVE_FOLLOW_MAX_DIST - d) * kc) / d,
                )
                camera.position.copy(controls.target).add(_followOffset)
              }
            }
          }

          lighting.update(camera.position)
          // 天空球跟随相机：使其表面恒在远裁剪面内，且相机移动时
          // 天空无相对位移。depthTest 已关闭，故移动不影响遮挡关系。
          sky.mesh.position.copy(camera.position)
          dust.update(camera.position, dt, now / 1000)

          const now2 = performance.now()
          frames += 1
          if (now2 - fpsMark >= 1000) {
            setFps(Math.round((frames * 1000) / (now2 - fpsMark)))
            frames = 0
            fpsMark = now2
          }
          if (now2 - lastHud >= 120) {
            lastHud = now
            const h = heightAt(hf, camera.position.x, camera.position.z)
            setFpMode((m) => (fp.isEnabled() && m !== fp.getMode()
              ? fp.getMode()
              : fp.isEnabled()
                ? m
                : null))
            setHud({
              x: camera.position.x,
              z: camera.position.z,
              h: h === -9999 ? 0 : h,
            })
          }

          renderer.render(scene, camera)
          minimap.render(
            renderer,
            camera,
            mount.clientWidth,
            mount.clientHeight,
          )
        }
        animate()

        const onResize = () => {
          if (!mount.clientWidth || !mount.clientHeight) return
          camera.aspect = mount.clientWidth / mount.clientHeight
          camera.updateProjectionMatrix()
          renderer.setSize(mount.clientWidth, mount.clientHeight)
        }
        window.addEventListener('resize', onResize)
        // 画布尺寸还受布局变化影响（任务面板出现/消失改变 flex 宽度），
        // 仅监听 window resize 会让画布保持旧尺寸、压到面板下面造成重叠
        resizeRef.current = onResize

        // 暴露给场景资源清理
        const host = mount as unknown as {
          __disposeScene?: () => void
          __scene?: THREE.Scene
          __debug?: Record<string, (...args: number[]) => string | number>
        }
        host.__scene = scene
        host.__debug = {
          camY: () => camera.position.y.toFixed(1),
          ground: () => {
            const h = heightAt(hf, camera.position.x, camera.position.z)
            return h === -9999 ? 'out' : h.toFixed(2)
          },
          mapSize: () => (material.map?.image as { width?: number })?.width ?? 0,
          vertices: () => geo.attributes.position.count,
          hMinMax: () => {
            let lo = Infinity
            let hi = -Infinity
            for (let i = 0; i < hf.data.length; i++) {
              const v = hf.data[i]
              if (v < lo) lo = v
              if (v > hi) hi = v
            }
            return `${lo.toFixed(1)}..${hi.toFixed(1)}`
          },
          /** 传送相机到世界坐标 (x, y) 附近（调试/演示用）。
           *  dist/h 可缺省：机位后撤距离与离地高度（米） */
          teleport: (x: number, y: number, dist = 7, h = 4) => {
            fp.disable()
            controls.enabled = true
            setFpMode(null)
            const g = heightAt(hf, x, y, exagRef.current)
            const gy = g === -9999 ? 0 : g
            const d = Math.max(dist, 1.5)
            camera.position.set(x + d, gy + Math.max(h, 0.5), y + d)
            controls.target.set(x, gy + 0.3, y)
            controls.update()
            return gy.toFixed(2)
          },
        }
        host.__disposeScene = () => {
          cancelAnimationFrame(raf)
          window.removeEventListener('resize', onResize)
          if (resizeRef.current === onResize) resizeRef.current = null
          rockDispose?.()
          renderer.domElement.removeEventListener('mousemove', onProbeMove)
          renderer.domElement.removeEventListener('mousedown', handlePointerDown)
          renderer.domElement.removeEventListener('click', handlePlanningClick)
          removeCapture()
          fp.dispose()
          minimap.dispose()
          dust.dispose()
          dustRef.current = null
          controls.dispose()
          lighting.dispose()
          sky.dispose()
          geo.dispose()
          material.dispose()
          normalTexRef.current?.dispose()
          normalTexRef.current = null
          roughnessTexRef.current?.dispose()
          roughnessTexRef.current = null
          gridGeo.dispose()
          ;(refGrid.material as THREE.Material).dispose()
          textureCache.current.forEach((t) => t.dispose())
          textureCache.current.clear()
          renderer.dispose()
          host.__scene = undefined
          if (renderer.domElement.parentNode === mount) {
            mount.removeChild(renderer.domElement)
          }
        }
      } catch (e) {
        console.error(e)
        if (!disposed) {
          setError(e instanceof Error ? e.message : '场景初始化失败')
        }
      }
    }

    void run()

    return () => {
      disposed = true
      const mountEl = mountRef.current
      const dispose = (
        mountEl as unknown as { __disposeScene?: () => void } | null
      )?.__disposeScene
      if (dispose) dispose()
      materialRef.current = null
              fpRef.current = null
              setSunDir.current = null
    }
  // 依赖 exaggeration 与 showGrid 是有意的：两者都会改变场景几何，
    // 因此需要重建而非增量更新。频繁拖动滑块时重建成本约 100–400 ms，
    // 由加载遮罩覆盖。
  }, [region, manifest, tier, exaggeration, showGrid, setFps])

  // 地方时驱动太阳位置与阴影方向
  useEffect(() => {
    if (!setSunDir.current || !meta) return
    const dir = sunDirection(
      localHour,
      meta.center.lat,
      MARS_SKY_PRESET.axialTiltDeg,
      MARS_SKY_PRESET.solHours,
    )
    setSunDir.current(dir)
  }, [localHour, meta])

  // 图层切换：仅换贴图，不重建几何体。
  // 面板允许多选，实际显示按列表自下而上取最后一个启用项，
  // 即「上层覆盖下层」：原始影像在最底层，语义分类在最上层。
  useEffect(() => {
    const mat = materialRef.current
    if (!mat || !manifest) return
    let active: LayerId | null = null
    for (const l of manifest.layers) {
      if (layers[l.id]) active = l.id
    }
    if (!active) return
    const tex = textureCache.current.get(active)
    if (tex) {
      mat.map = tex
      mat.opacity = layerOpacity[active]
      mat.transparent = mat.opacity < 1
      mat.needsUpdate = true
    }
  }, [layers, layerOpacity, manifest, ready])

  // 规划模式切换（28.2）：规划时强制环绕相机（禁第一人称指针锁定），
  // 退出后回到默认第一人称。场景重建（ready 翻转）后同样生效。
  useEffect(() => {
    const fp = fpRef.current
    const controls = controlsRef.current
    if (!fp || !controls || !ready) return
    if (planningLoggedRef.current !== null && planningLoggedRef.current !== planning) {
      planningLoggedRef.current = planning
      logEvent('sys', planning ? '进入任务规划模式' : '退出任务规划模式')
    }
    planningLoggedRef.current = planning
    if (planning) {
      if (fp.isEnabled()) fp.disable()
      controls.enabled = true
      setFpMode(null)
    } else {
      if (!fp.isEnabled()) fp.enable()
      controls.enabled = false
    }
  }, [planning, ready])

  // 任务标记重建：活动列表、选中态或场景重建后重新构建标记组。
  // 退出规划模式即清除全部标记（规则：任务痕迹只存在于规划中）
  useEffect(() => {
    const hf = hfRef.current
    const scene = sceneRef.current
    if (!hf || !scene || !ready) return
    const prev = taskMarkersRef.current
    if (prev) {
      scene.remove(prev.group)
      prev.dispose()
      taskMarkersRef.current = null
    }
    if (!planning || activities.length === 0) return
    const mk = createTaskMarkers(hf, exagRef.current, activities, selectedId)
    scene.add(mk.group)
    taskMarkersRef.current = mk
  }, [activities, selectedId, ready, planning])

  // 画布容器尺寸跟踪：任务规划面板出现/消失会改变 flex 布局宽度，
  // ResizeObserver 触发与 window resize 相同的相机/渲染器更新
  useEffect(() => {
    const mount = mountRef.current
    if (!mount || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => resizeRef.current?.())
    ro.observe(mount)
    return () => ro.disconnect()
  }, [])

  // ---- 实时仿真：启动 / 停止 ----
  const stopLive = () => {
    abortRef.current?.()
    abortRef.current = null
    liveEndedRef.current = false
    setLiveActive(false)
  }

  const startLive = (mission: Mission, activityId: string) => {
    const scene = sceneRef.current
    const hf = hfRef.current
    if (!scene || !hf || !region) return

    // 清理上一轮的小车与轨迹线
    abortRef.current?.()
    const prevRv = roverRef.current
    if (prevRv) {
      prevRv.rig.dispose()
      prevRv.scene.remove(prevRv.rig.group)
      roverRef.current = null
    }
    const prevTrail = trailRef.current
    if (prevTrail) {
      prevTrail.line.geometry.dispose()
      ;(prevTrail.line.material as THREE.Material).dispose()
      trailRef.current = null
    }
    // 清理上一轮的顶点照片与雷达成像（主地图圆盘 + 独立窗口）
    photosRef.current = []
    setPhotos([])
    const prevDisc = radarDiscRef.current
    if (prevDisc) {
      prevDisc.scene.remove(prevDisc.group)
      prevDisc.mat.dispose()
      prevDisc.ring.geometry.dispose()
      ;(prevDisc.ring.material as THREE.Material).dispose()
      radarDiscRef.current = null
    }
    radarWinOpenRef.current = false
    setRadarWinOpen(false)
    setRadarCoverage(0)

    // 小车入场景
    const rig = createRover()
    scene.add(rig.group)
    roverRef.current = { rig, scene }

    // 初始位姿与环境出生点一致：TRAVERSE 取首个途经点；SURVEY_PATH
    // 取质心（环境从三角区中心出发驶向第一个顶点——出生在顶点上
    // 会导致「开始仿真即拍照」，实测反馈已修）；TARGETED 取目标点。
    // 不停留在场景原点：否则首帧到达前小车位于地图中心，相机跟随
    // 也要等帧，表现为「开始仿真后看不到车、视角不变」。
    const acts = mission.sols.flatMap((s) => s.activities)
    const act = acts.find((a) => a.id === activityId) ?? acts[0]
    const centroidT = act?.targets.find((t) => t.role === 'centroid')
    const pts = (act?.targets ?? []).filter(
      (t) => t.role !== 'orientation' && t.role !== 'centroid',
    )
    const p0 =
      act?.type === 'SURVEY_PATH'
        ? centroidT ?? pts[0] ?? act?.targets[0]
        : pts[0] ?? act?.targets[0]
    const p1 =
      act?.type === 'SURVEY_PATH'
        ? pts[0] // 质心出发时朝向第一个顶点
        : pts[1]
    const sx = p0 ? p0.x : 0
    const sy = p0 ? p0.y : 0
    const syaw = p0 && p1 ? Math.atan2(p1.y - p0.y, p1.x - p0.x) : 0
    roverRenderRef.current = { x: sx, y: sy, yaw: syaw }
    roverTargetRef.current = { x: sx, y: sy, yaw: syaw, v: 0 }
    if (p0) rig.setPose(sx, sy, syaw, hf, exagRef.current)

    // 相机立刻拉到小车附近；首帧到达后再按真实出生点校正一次
    snapCameraNearRover(sx, sy, syaw)
    liveSnapRef.current = true

    // 轨迹尾线（预分配 2 万点，随播放增长）
    const maxPts = 20000
    const positions = new Float32Array(maxPts * 3)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setDrawRange(0, 0)
    const line = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({
        color: 0x00e5ff, transparent: true, opacity: 0.5,
      }),
    )
    line.frustumCulled = false
    scene.add(line)
    trailRef.current = { line, positions, count: 0 }

    liveFramesRef.current = []
    liveMissionIdRef.current = mission.mission_id
    prevProgressRef.current = ''
    setLiveDone(null)
    setLiveError(null)
    setLiveFrame(null)
    setLiveActive(true)
    liveEndedRef.current = false
    logEvent('sys', `实时仿真开始 · 任务「${mission.name ?? mission.mission_id}」`)

    abortRef.current = startLiveRun(
      region.meta.name,
      mission,
      activityId,
      {
        // 只入缓冲；仪表面板由消费循环驱动（显示当前播放帧），
        // 保证地图上的小车/轨迹与面板数字始终同一步。
        onFrame: (f) => {
          liveFramesRef.current.push(f)
        },
        onDone: (d) => {
          // 不立即停：标记流结束，让消费循环排空缓冲（轨迹补完），
          // 播完后自动停止，避免「任务结束轨迹还在慢慢出现」。
          liveEndedRef.current = true
          setLiveDone(d)
          const m = d.metrics
          logEvent(
            m.success ? 'sys' : 'warn',
            `${m.success ? '✓ 任务成功' : `✗ 任务结束（${m.terminated_reason}）`} · ` +
              `用时 ${m.time_s.toFixed(0)}s · 路径 ${m.path_len_m.toFixed(0)}m` +
              (m.spl != null ? ` · SPL ${m.spl.toFixed(3)}` : ''),
          )
          logEvent('sys', `轨迹已保存：${d.trajectory_file}`)
        },
        onError: (m) => {
          liveEndedRef.current = false
          setLiveError(m)
          setLiveActive(false)
          logEvent('err', `实时仿真错误：${m}`)
        },
      },
      { frame_s: 0.25, seed: 0, v_scale: roverSpeed },
    )
  }

  /** 火星车速度调节：本地状态 + 运行期接口（下一步立即生效） */
  const handleRoverSpeedChange = (v: number) => {
    setRoverSpeed(v)
    const region_name = region?.meta.name
    if (!region_name || !liveMissionIdRef.current) return
    void setLiveRoverSpeed(region_name, liveMissionIdRef.current, v).catch(
      (e) => console.error('车速调节失败', e),
    )
  }

  // 卸载时中止连接并释放小车
  useEffect(
    () => () => {
      abortRef.current?.()
      roverRef.current?.rig.dispose()
    },
    [],
  )

  // 场景重建（画质/夸张系数/网格变化）后：旧场景上的小车与轨迹线
  // 随 __disposeScene 释放，进行中的实时仿真自动中止，避免帧打到
  // 已销毁的场景上。
  useEffect(() => {
    const rv = roverRef.current
    if (rv && sceneRef.current && rv.scene !== sceneRef.current) {
      abortRef.current?.()
      abortRef.current = null
      liveEndedRef.current = false
      setLiveActive(false)
      setLiveError('场景已重建，实时仿真已中止（请重新开始）')
      logEvent('warn', '场景已重建，实时仿真已中止')
      rv.rig.dispose()
      roverRef.current = null
      trailRef.current = null
      // 雷达成像圆盘挂在旧场景上，一并置空（下次扫描按新场景重建）
      radarDiscRef.current = null
      dustRef.current = null
    }
  }, [ready])

  if (!region || !meta || !manifest) return null

  const sunAlt = sunAltitude(
    localHour,
    meta.center.lat,
    MARS_SKY_PRESET.axialTiltDeg,
    MARS_SKY_PRESET.solHours,
  )

  return (
    <div className="relative w-full h-full flex">
      <EventLog />

      <div className="relative flex-1">
        <div ref={mountRef} className="absolute inset-0" />

        {(!ready || error) && (
          <div className="absolute inset-0 flex items-center justify-center bg-ink-950/60 pointer-events-none">
            <div className="panel px-5 py-3 text-sm text-bone-dim">
              {error ?? '正在构建地形…'}
            </div>
          </div>
        )}

        {ready && !error && (
          <>
            {/* 左下：任务控制台读数条（坐标/离地/太阳 + 分辨率/网格） */}
            <div className="absolute left-4 bottom-4 console-panel hud-corners px-3 py-2 pointer-events-none">
              <div className="num text-xs text-bone-dim leading-relaxed">
                <div className="flex gap-4">
                  <span>
                    E <span className="text-bone">{hud.x.toFixed(1)}</span>
                  </span>
                  <span>
                    S <span className="text-bone">{hud.z.toFixed(1)}</span>
                  </span>
                  <span>
                    AGL <span className="text-bone">{hud.h.toFixed(1)}m</span>
                  </span>
                  <span>
                    SUN <span className="text-bone">{sunAlt.toFixed(1)}°</span>
                  </span>
                </div>
                <div className="flex gap-4 text-[11px] mt-0.5">
                  <span>
                    RES{' '}
                    <span className="text-bone">
                      {res ? `${res.w}×${res.h}` : '—'}
                    </span>
                  </span>
                  <span>
                    GRID <span className="text-bone">{manifest.grid}²</span>
                  </span>
                </div>
                <div className="text-bone-faint mt-1">
                  {liveActive
                    ? '实时仿真中 · 车载仪表面板显示雷达与姿态'
                    : planning
                      ? '规划模式 · 点击地形放置任务点 · 点击标记选中 · 顶栏「任务规划」退出'
                      : fpMode === null
                        ? '环绕视角 · V 进入第一人称 · 左键旋转 · 滚轮缩放 · 右键平移'
                        : `第一人称${fpMode === 'fly' ? '飞行' : '贴地'} · WASD 移动 · 空格 上升 · Shift 下降 · Ctrl 加速 · F 切换贴地/飞行 · V 切换环绕`}
                </div>
              </div>
            </div>

            {/* 小地图容器：位置与尺寸需与 Minimap.render 的视口一致。
                不能用带背景/毛玻璃的容器样式——其 backdrop-blur 会把
                下方主画布渲染的视口像素一起模糊，导致小地图发虚 */}
            <div
              className="absolute pointer-events-none hud-corners border border-ink-600/70"
              style={{
                right: 12,
                bottom: 12,
                width: 256,
                height: 256,
              }}
            >
              <div className="absolute top-1 left-1/2 -translate-x-1/2 text-[10px] text-bone-dim">
                北 N
              </div>
              <div className="absolute bottom-1 left-1/2 -translate-x-1/2 text-[10px] text-bone-dim">
                南 S
              </div>
              <div className="absolute left-1 top-1/2 -translate-y-1/2 text-[10px] text-bone-dim">
                西 W
              </div>
              <div className="absolute right-1 top-1/2 -translate-y-1/2 text-[10px] text-bone-dim">
                东 E
              </div>
            </div>

          </>
        )}
      </div>

      {(liveActive || liveDone || liveError) && (
        <TelemetryPanel
          frame={liveFrame}
          done={liveDone}
          error={liveError}
          roverSpeed={roverSpeed}
          onRoverSpeedChange={handleRoverSpeedChange}
          follow={liveFollow}
          onFollowChange={setLiveFollow}
          onClose={() => {
            stopLive()
            setLiveDone(null)
            setLiveError(null)
          }}
        />
      )}

      {/* 顶点成像照片墙（SURVEY_PATH：仿真中/结束后可回看下载） */}
      {photos.length > 0 && (
        <PhotoPanel
          photos={photos}
          onClose={() => {
            photosRef.current = []
            setPhotos([])
          }}
        />
      )}

      {/* 雷达成像点云独立 3D 窗口（抵近任务扫描阶段自动打开） */}
      {radarWinOpen && (
        <RadarScanWindow
          open
          onClose={() => {
            radarWinOpenRef.current = false
            setRadarWinOpen(false)
          }}
          handleRef={radarWinRef}
          coverage={radarCoverage}
        />
      )}

      {planning ? (
        <TaskPanel
          activities={activities}
          selectedId={selectedId}
          missionName={missionName}
          saveError={saveError}
          onSaveError={setSaveError}
          placementType={placementType}
          onPlacementTypeChange={setPlacementType}
          onSelect={setSelectedId}
          onDelete={(id) => {
            setActivities((prev) => prev.filter((a) => a.id !== id))
            setSelectedId((prev) => (prev === id ? null : prev))
          }}
          onMove={(id, dir) => {
            setActivities((prev) => {
              const i = prev.findIndex((a) => a.id === id)
              const j = i + dir
              if (i < 0 || j < 0 || j >= prev.length) return prev
              const next = [...prev]
              ;[next[i], next[j]] = [next[j], next[i]]
              return next
            })
          }}
          onFovChange={(id, fov: number) => {
            setActivities((prev) =>
              prev.map((a) => (a.id === id ? { ...a, fov } : a)),
            )
          }}
          onNameChange={(v) => {
            setMissionName(v)
            setSaveError(null)
          }}
          onStartLive={(m, id) => startLive(m, id)}
          onLoadMission={(m: Mission) => {
            setActivities(m.sols[0]?.activities ?? [])
            setSelectedId(null)
            setMissionName(m.name ?? m.mission_id)
            setSaveError(null)
          }}
        />
      ) : (
        <InfoPanel
          profiles={profiles}
          probe={probe}
          probeEnabled={probeEnabled}
          onProbeToggle={(on) => {
            setProbeEnabled(on)
            if (!on) {
              // 关闭时立即隐藏标记环并清空读数
              const mk = probeMarkerRef.current
              if (mk && mk.scene === sceneRef.current) mk.group.visible = false
              setProbe(null)
            }
          }}
        />
      )}

      <StatusBar />
    </div>
  )
}