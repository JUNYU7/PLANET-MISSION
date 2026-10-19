import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { Line2 } from 'three/examples/jsm/lines/Line2.js'
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import {
  fetchGlobeMeta,
  fetchRegionDetail,
  fetchRegions,
  globeTextureUrl,
} from '../api/client'
import { useApp } from '../store/AppContext'
import type { GlobeMeta, RegionSummary } from '../types'

/** 火星半径按 1:1e6 缩放后的场景单位，与 V4 文档 6.1 节一致。 */
const GLOBE_RADIUS = 3.396

/**
 * 经纬度 → 球面坐标。
 *
 * 公式与后端 core.coords.lonlat_to_sphere 完全一致（V4 文档 6.2 节）：
 *   φ = (90 − lat)·π/180,  θ = (lon + 180)·π/180
 *   x = −R·sin φ·cos θ,   y = R·cos φ,   z = R·sin φ·sin θ
 * 北纬为正、东经为正。约定反了会让标记落到球体背面。
 *
 * Mars.tif 经度约定为标准 −180~+180，已由暗斑位置反推验证
 * （南纬 20~0 度带最暗斑落在 70.2°E，与 Syrtis Major 吻合）。
 */
function lonLatToSphere(
  lon: number,
  lat: number,
  radius: number,
): THREE.Vector3 {
  const phi = ((90 - lat) * Math.PI) / 180
  const theta = ((lon + 180) * Math.PI) / 180
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  )
}

/**
 * 由经纬度包围盒生成贴合球面的矩形轮廓。
 *
 * 不能直接用四条直线段连接四角：那样会弦穿球体内部，在球面上看起来
 * 像梯形而非矩形。这里按经纬度均匀细分四条边，每点用球面坐标精确计算，
 * 得到真正沿球面的大圆弧轮廓。
 */
function footprintOutline(
  fp: { lon_min: number; lon_max: number; lat_min: number; lat_max: number },
  radius: number,
  segmentsPerEdge = 24,
): THREE.Vector3[] {
  const pts: THREE.Vector3[] = []
  const push = (lon: number, lat: number) => {
    pts.push(lonLatToSphere(lon, lat, radius))
  }
  const { lon_min, lon_max, lat_min, lat_max } = fp
  for (let i = 0; i < segmentsPerEdge; i++) {
    const t = i / segmentsPerEdge
    push(lon_min + (lon_max - lon_min) * t, lat_min)
  }
  for (let i = 0; i < segmentsPerEdge; i++) {
    const t = i / segmentsPerEdge
    push(lon_max, lat_min + (lat_max - lat_min) * t)
  }
  for (let i = 0; i < segmentsPerEdge; i++) {
    const t = i / segmentsPerEdge
    push(lon_max - (lon_max - lon_min) * t, lat_max)
  }
  for (let i = 0; i < segmentsPerEdge; i++) {
    const t = i / segmentsPerEdge
    push(lon_min, lat_max - (lat_max - lat_min) * t)
  }
  return pts
}

/**
 * 足迹显示的最小角跨度（度）。
 *
 * HiRISE 单景覆盖约 21.4 km 宽，换算到球面仅约 0.36 度；球体在屏幕上
 * 约 500 px 对应 23.6 度角直径，因此真实足迹的显示尺寸只有约 8 px，
 * 无论线宽多粗都难以辨识。此处把显示尺寸放大到可辨认的最小跨度，
 * 中心位置保持精确——中心是真实的，尺寸仅为示意。
 * 真实覆盖范围在左侧列表中以公里数给出。
 */
const MIN_VISIBLE_SPAN_DEG = 5.0

/** 将足迹按最小可见跨度等比放大，保持中心不变。 */
function expandFootprint(
  fp: {
    lon_min: number
    lon_max: number
    lat_min: number
    lat_max: number
  },
  minSpanDeg: number,
): {
  lon_min: number
  lon_max: number
  lat_min: number
  lat_max: number
} {
  const cLon = (fp.lon_min + fp.lon_max) / 2
  const cLat = (fp.lat_min + fp.lat_max) / 2
  // 经度跨度在高纬度需除以 cos(lat) 才能对应同样的地面距离
  const k = Math.max(Math.cos((Math.abs(cLat) * Math.PI) / 180), 0.05)
  const halfLat = Math.max((fp.lat_max - fp.lat_min) / 2, minSpanDeg / 2)
  const halfLon = Math.max(
    (fp.lon_max - fp.lon_min) / 2,
    minSpanDeg / 2 / k,
  )
  return {
    lon_min: cLon - halfLon,
    lon_max: cLon + halfLon,
    lat_min: cLat - halfLat,
    lat_max: cLat + halfLat,
  }
}

export default function GlobeView() {
  const mountRef = useRef<HTMLDivElement | null>(null)
  const { openRegion } = useApp()
  const [globeMeta, setGlobeMeta] = useState<GlobeMeta | null>(null)
  const [regions, setRegions] = useState<RegionSummary[]>([])
  const [hovered, setHovered] = useState<string | null>(null)
  const [loadingList, setLoadingList] = useState(true)
  const [loadingRegion, setLoadingRegion] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // hovered 会随鼠标移动频繁变化，若直接作为场景初始化依赖会导致
  // 每次悬停都重建球体与纹理。用 ref 供渲染循环读取，场景只初始化一次。
  const hoveredRef = useRef<string | null>(null)
  hoveredRef.current = hovered

  const onSelect = async (name: string) => {
    setLoadingRegion(name)
    setLoadError(null)
    try {
      const detail = await fetchRegionDetail(name)
      openRegion(detail)
    } catch (err) {
      console.error(err)
      setLoadError('区域数据加载失败，请确认已执行数据处理')
    } finally {
      setLoadingRegion(null)
    }
  }

  useEffect(() => {
    fetchGlobeMeta()
      .then(setGlobeMeta)
      .catch(() => console.error('球体元信息加载失败'))
    fetchRegions()
      .then((d) => setRegions(d.regions))
      .catch(() => console.error('区域列表加载失败'))
      .finally(() => setLoadingList(false))
  }, [])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0d0b0a)

    const camera = new THREE.PerspectiveCamera(
      38,
      mount.clientWidth / Math.max(mount.clientHeight, 1),
      0.1,
      200,
    )
    // 相机距离决定球体在屏幕上的直径。实测1440x720 贴图在直径约
    // 620px 时已显模糊，故拉远至约 500px，与贴图的实际分辨力匹配。
        // 距离由球体角直径与视场角反解得到：2·asin(R/d) = 视口占比 × fov。
        //
        // 注意朝向：lonLatToSphere 约定本初子午线（lon=0）落在 +X、
        // lon=90°E 落在 -Z。若把相机放在 +Z，则 lon≈77°E 的目标恰好在背面。
        // 因此相机置于 +X 方向，Jezero 区域朝向观察者。
        const targetDiameterPx = Math.min(
          globeMeta?.screen_diameter_px ?? 500,
          mount.clientHeight * 0.62,
        )
        const vfov = (38 * Math.PI) / 180
        const angular = (targetDiameterPx / mount.clientHeight) * vfov
        const camDist = GLOBE_RADIUS / Math.sin(angular / 2)
        // 相机置于 Jezero 区域所在的球面法线方向，使该区域正面朝向观察者。
        // lonLatToSphere 约定 lon=0 在 +X、lon=90E 在 -Z，因此 lon77.4E
        // 区域的法线约为 (0.207, 0.317, -0.926)，沿该方向拉远相机即可正视。
        camera.position.set(
          camDist * 0.207,
          camDist * 0.317,
          camDist * -0.926,
        )

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(mount.clientWidth, mount.clientHeight)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    mount.appendChild(renderer.domElement)

    // 照明：全球视图的用途是浏览全表面影像与定位区域，不是模拟某一时刻的
    // 太阳照明，因此必须让整个球面都可读。
    //
    // 历史问题（「一半亮一半暗」）：原先只有一盏 DirectionalLight，而它的
    // target 默认在场景原点——球心恰在原点，于是只有法线朝向 (5,2,4) 的
    // 半个球面被直接照亮，背光侧只剩1.35 强度的深棕 AmbientLight，视觉上
    // 明暗分界生硬，近半张全球影像完全无法判读。纹理本身是好的
    // （Mars.tif 四象限均值 148~155，无缺失像素）。
    //
    // 现改为「半球光打底 + 跟随相机的弱方向光塑形」：
    // - 半球光从天空暖白渐变到地面淡棕，对任意朝向的面都有照度，
    //   不存在暗面，且保留上亮下暗的球体感；
    // - 方向光每帧移到相机所在方向（target 固定原点并加入场景图，
    //   与 RoverModel 中 SpotLight 的处理同理，否则矩阵不更新），
    //   强度压低到只做高光塑形，旋转到任何角度都不产生大片暗面。
    const hemi = new THREE.HemisphereLight(0xfff4e8, 0xa08a76, 2.0)
    scene.add(hemi)
    const key = new THREE.DirectionalLight(0xfff0e0, 0.8)
    key.target.position.set(0, 0, 0)
    scene.add(key.target)
    scene.add(key)

    const globe = new THREE.Mesh(
      new THREE.SphereGeometry(GLOBE_RADIUS, 96, 64),
      new THREE.MeshStandardMaterial({
        roughness: 0.96,
        metalness: 0,
      }),
    )
    scene.add(globe)

    new THREE.TextureLoader().load(globeTextureUrl(), (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy()
      const mat = globe.material as THREE.MeshStandardMaterial
      mat.map = tex
      mat.needsUpdate = true
    })

    // 区域标记：矩形轮廓 + 半透明填充 + 中心点，全部固定在球面上。
    // 轮廓半径略微外扩，避免与球面表面 z-fighting。
    //
    // 线宽注意：WebGL 的 linewidth 在多数实现中被忽略，LineBasicMaterial
    // 始终渲染为 1px。该 footprint 跨度约 0.36 度，在 500px 球面上仅约
    // 25px，1px 细线在深色背景上几乎不可见。因此额外叠加一层
    // 半透明填充面，使区域在视觉上明确可辨。
    const OUTLINE_R = GLOBE_RADIUS * 1.004
    const markerGroup = new THREE.Group()
    const hitTargets: THREE.Object3D[] = []
    const lineMats: LineMaterial[] = []

    for (const r of regions) {
      const fp = r.footprint
      if (fp) {
        // 显示尺寸放大到可辨认的最小跨度，中心保持精确
        const shown = expandFootprint(fp, MIN_VISIBLE_SPAN_DEG)
        const pts = footprintOutline(shown, OUTLINE_R, 48)

        // 用 Line2 而非 Line：WebGL 忽略 LineBasicMaterial 的 linewidth，
        // 恒定渲染为 1px，在橙色球面上几乎不可辨。Line2 以屏幕像素为单位。
        const flat: number[] = []
        for (const pt of pts) flat.push(pt.x, pt.y, pt.z)
        flat.push(pts[0].x, pts[0].y, pts[0].z)
        const geo = new LineGeometry()
        geo.setPositions(flat)
        const mat = new LineMaterial({
          color: 0x00e5ff,
          linewidth: 2,
          transparent: true,
          opacity: 0.95,
        })
        mat.resolution.set(mount.clientWidth, mount.clientHeight)
        lineMats.push(mat)
        const line = new Line2(geo, mat)
        line.computeLineDistances()
        line.renderOrder = 10
        line.userData.regionName = r.name
        line.userData.kind = 'line'
        markerGroup.add(line)
        hitTargets.push(line)

        // 半透明填充，使区域边界在视觉上明确可辨
        const center = lonLatToSphere(
          (shown.lon_min + shown.lon_max) / 2,
          (shown.lat_min + shown.lat_max) / 2,
          OUTLINE_R,
        )
        const verts: number[] = []
        for (const p of pts) {
          verts.push(center.x, center.y, center.z)
          verts.push(p.x, p.y, p.z)
        }
        const fanGeo = new THREE.BufferGeometry()
        fanGeo.setAttribute(
          'position',
          new THREE.Float32BufferAttribute(verts, 3),
        )
        const fill = new THREE.Mesh(
          fanGeo,
          new THREE.MeshBasicMaterial({
            color: 0x00e5ff,
            transparent: true,
            opacity: 0.26,
            side: THREE.DoubleSide,
            depthWrite: false,
          }),
        )
        fill.renderOrder = 9
        fill.userData.regionName = r.name
        fill.userData.kind = 'fill'
        markerGroup.add(fill)
        hitTargets.push(fill)
      }

      const pos = lonLatToSphere(
        r.landing_site.lon,
        r.landing_site.lat,
        OUTLINE_R,
      )
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(GLOBE_RADIUS * 0.007, 14, 12),
        new THREE.MeshBasicMaterial({ color: 0xe8613c }),
      )
      dot.position.copy(pos)
      dot.renderOrder = 11
      dot.userData.regionName = r.name
      dot.userData.kind = 'dot'
      markerGroup.add(dot)
      hitTargets.push(dot)
    }

    // 标记放入独立 overlay 场景：Line2 与半透明填充均为透明材质，
    // three.js 会将其排到不透明球体之后，此时 depthTest:false 已失效
    // （球体已写入深度缓冲）。在主场景渲染完毕后单独渲染 overlay，
    // 可保证标记始终可见，同时位置仍严格贴合球面。
    const overlay = new THREE.Scene()
    overlay.add(markerGroup)


    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.minDistance = GLOBE_RADIUS * 1.35
    controls.maxDistance = GLOBE_RADIUS * 4
    controls.enablePan = false

    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()

    const onMove = (ev: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointer, camera)
      const hit = raycaster.intersectObjects(hitTargets, false)
      const name = hit.length > 0 ? String(hit[0].object.userData.regionName) : null
      if (name !== hoveredRef.current) {
        hoveredRef.current = name
        setHovered(name)
      }
      renderer.domElement.style.cursor = name ? 'pointer' : 'default'
    }

    const onClick = () => {
      const name = hoveredRef.current
      if (name) void onSelect(name)
    }

    renderer.domElement.addEventListener('mousemove', onMove)
    renderer.domElement.addEventListener('click', onClick)

    let raf = 0
    const animate = () => {
      raf = requestAnimationFrame(animate)
      controls.update()
      // 塑形光跟随相机：被照亮的一侧始终朝向观察者。方向光 target 固定
      // 在球心（构造时已加入场景图，矩阵每帧有效），因此只需更新位置。
      key.position.copy(camera.position)
      // 只更新悬停反馈，不改动标记位置与朝向。
      // 注意不能用 obj instanceof THREE.Line 区分线框：Line2 继承自
      // Mesh 而非 THREE.Line，判断不中会被当成普通网格执行 scale——
      // 而线框与填充面的顶点是绕全球原点的绝对坐标，缩放会把矩形框
      // 放大并甩到球面另一侧。因此按 userData.kind 分派：只有中心点
      // （几何以自身位置为原点）允许缩放，线框与填充用颜色/透明度
      // 表达高亮。
      markerGroup.children.forEach((obj) => {
        const kind = obj.userData.kind as string
        const active = (obj.userData.regionName as string) === hoveredRef.current
        const mat = (obj as THREE.Mesh).material as THREE.Material & {
          opacity: number
          color: THREE.Color
        }
        if (kind === 'dot') {
          ;(obj as THREE.Mesh).scale.setScalar(active ? 1.9 : 1)
          return
        }
        if (kind === 'fill') {
          mat.opacity = active ? 0.45 : 0.26
          return
        }
        mat.opacity = active ? 1 : 0.8
        mat.color.setHex(active ? 0xe8613c : 0x00e5ff)
      })
      renderer.render(scene, camera)
      renderer.autoClear = false
      renderer.clearDepth()
      renderer.render(overlay, camera)
      renderer.autoClear = true
    }
    animate()

    const onResize = () => {
      if (!mount.clientWidth || !mount.clientHeight) return
      camera.aspect = mount.clientWidth / mount.clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(mount.clientWidth, mount.clientHeight)
      // Line2 的 linewidth 以像素为单位，依赖分辨率 uniform；
      // 画布尺寸变化后必须同步，否则线宽比例会失真。
      for (const m of lineMats) {
        m.resolution.set(mount.clientWidth, mount.clientHeight)
      }
    }
    window.addEventListener('resize', onResize)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      renderer.domElement.removeEventListener('mousemove', onMove)
      renderer.domElement.removeEventListener('click', onClick)
      controls.dispose()
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        if (mesh.geometry) mesh.geometry.dispose()
        const mat = mesh.material as THREE.Material | THREE.Material[]
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
        else if (mat) mat.dispose()
      })
      renderer.dispose()
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement)
      }
    }
  }, [regions, globeMeta?.screen_diameter_px])

  return (
    <div className="relative w-full h-full">
      <div ref={mountRef} className="absolute inset-0" />

      {/* 区域列表面板 */}
      <div className="absolute top-4 left-4 w-64 panel">
        <div className="panel-header">Target Registry · 目标注册表</div>
        <div className="p-2">
          {regions.length === 0 && (
            <p className="text-xs text-bone-faint px-2 py-3">
              尚无已处理区域。请先运行数据处理生成区域产物。
            </p>
          )}
          {regions.map((r) => {
            const active = hovered === r.name
            return (
              <button
                key={r.name}
                type="button"
                onClick={() => void onSelect(r.name)}
                onMouseEnter={() => setHovered(r.name)}
                onMouseLeave={() => setHovered(null)}
                className={`w-full text-left px-2 py-2 mb-1 border transition-colors duration-150 ${
                  active
                    ? 'border-rust bg-ink-600'
                    : 'border-transparent hover:border-ink-500 hover:bg-ink-700'
                }`}
              >
                <div className="text-sm text-bone truncate">
                  {r.name.replace(/_/g, ' ')}
                </div>
                <div className="num text-xs text-bone-faint mt-0.5">
                  {r.landing_site.lat.toFixed(4)}°N{' '}
                  {r.landing_site.lon.toFixed(4)}°E · {r.size_m} m
                </div>
                {r.footprint && (
                  <div className="num text-[10px] text-bone-faint mt-0.5">
                    源影像覆盖 {(r.footprint.width_m / 1000).toFixed(1)} × {(r.footprint.height_m / 1000).toFixed(1)} km
                  </div>
                )}
                
              </button>
            )
          })}
        </div>
      </div>

      {/* 图例与提示 */}
      <div className="absolute bottom-4 left-4 panel px-3 py-2">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="w-2.5 h-2.5 rounded-full border border-signal-marker" />
          <span className="text-xs text-bone-dim">已注册区域</span>
        </div>
        <p className="text-xs text-bone-faint max-w-56 leading-relaxed">
          矩形框示意源影像覆盖范围，为便于辨识已放大显示，真实尺寸见列表。
          点击标记或列表项进入区域三维场景。球体贴图为火星全球影像，
          仅用于定位与展示，不参与地形计算。
        </p>
      </div>

      {globeMeta && (
        <div className="absolute bottom-4 right-4 panel px-3 py-2 num text-xs text-bone-faint">
          贴图 {globeMeta.texture_width}×{globeMeta.texture_height} · 建议球体直径{' '}
          {globeMeta.screen_diameter_px} px
        </div>
      )}

      {(loadingRegion !== null || loadError) && (
        <div className="absolute inset-0 flex items-center justify-center bg-ink-950/70">
          <div className="panel px-5 py-3 text-sm text-bone-dim">
            {loadError ?? '正在加载区域数据…'}
          </div>
        </div>
      )}

      {loadingList && regions.length === 0 && (
        <div className="absolute top-4 left-4 w-64 panel px-3 py-3 text-xs text-bone-faint">
          正在读取区域索引…
        </div>
      )}
    </div>
  )
}