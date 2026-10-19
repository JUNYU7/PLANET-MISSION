import { useEffect, useRef } from 'react'
import * as THREE from 'three'

/**
 * IMU 三维陀螺仪（面板内嵌小型 three.js 渲染器）。
 *
 * 结构仿真实陀螺仪：外圈固定常平环 + 随航向旋转的航向环（带刻度尖）
 * + 姿态球（上半天空色 / 下半地形色，赤道线即地平线）。姿态球的
 * 上轴对齐地形法线——车在坡上时地平线随之倾斜，直观呈现俯仰/横滚；
 * 球心转速环为陀螺转子（绕姿态轴快速自转，纯视觉）。
 *
 * 姿态数据由 RegionView 用高程场差分求得（与渲染地形同源）。
 */

interface Props {
  /** 地形法线（世界坐标，已归一化）；null 时保持当前姿态 */
  normal: { x: number; y: number; z: number } | null
  /** 航向（rad，世界 yaw） */
  yaw: number
}

const SIZE = 132

export default function AttitudeGyro({ normal, yaw }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const targetRef = useRef({ normal, yaw })
  targetRef.current = { normal, yaw }

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    } catch {
      return // WebGL 不可用时静默跳过（数字读数仍在旁边）
    }
    renderer.setSize(SIZE, SIZE)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 20)
    camera.position.set(0.9, 1.1, 2.7)
    camera.lookAt(0, 0, 0)

    scene.add(new THREE.AmbientLight(0xffffff, 0.85))
    const key = new THREE.DirectionalLight(0xfff2e0, 1.4)
    key.position.set(2, 3, 2)
    scene.add(key)

    const disposables: Array<{ dispose: () => void }> = []
    const track = <T extends { dispose: () => void }>(x: T): T => {
      disposables.push(x)
      return x
    }

    const ringMat = track(new THREE.MeshStandardMaterial({
      color: 0x6b5d54, roughness: 0.5, metalness: 0.3,
    }))
    const tickMat = track(new THREE.MeshBasicMaterial({ color: 0xe8613c }))

    // 固定常平环（水平外圈 + 两侧支承）
    const gimbalRing = new THREE.Mesh(
      track(new THREE.TorusGeometry(0.92, 0.018, 8, 48)),
      ringMat,
    )
    gimbalRing.rotation.x = Math.PI / 2
    scene.add(gimbalRing)
    for (const sz of [-1, 1]) {
      const post = new THREE.Mesh(
        track(new THREE.CylinderGeometry(0.02, 0.02, 0.24, 8)),
        ringMat,
      )
      post.position.set(0, sz * 0.08, sz * 0.92)
      scene.add(post)
    }

    // 航向环：随 yaw 旋转，带一个红色刻度尖指示航向
    const yawGroup = new THREE.Group()
    scene.add(yawGroup)
    const yawRing = new THREE.Mesh(
      track(new THREE.TorusGeometry(0.76, 0.014, 8, 48)),
      track(new THREE.MeshStandardMaterial({
        color: 0x8f959d, roughness: 0.5, metalness: 0.3,
      })),
    )
    yawRing.rotation.x = Math.PI / 2
    yawGroup.add(yawRing)
    const tick = new THREE.Mesh(
      track(new THREE.BoxGeometry(0.03, 0.03, 0.09)),
      tickMat,
    )
    tick.position.set(0, 0, 0.76)
    yawGroup.add(tick)

    // 姿态球：上半天空 / 下半地形，赤道线 = 地平线
    const ball = new THREE.Group()
    scene.add(ball)
    const skyGeo = track(new THREE.SphereGeometry(0.55, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2))
    const groundGeo = track(new THREE.SphereGeometry(0.55, 24, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2))
    const skyMat = track(new THREE.MeshBasicMaterial({
      color: 0x7aa5b8, transparent: true, opacity: 0.4, depthWrite: false,
    }))
    const groundMat = track(new THREE.MeshBasicMaterial({
      color: 0x8a4a26, transparent: true, opacity: 0.45, depthWrite: false,
    }))
    ball.add(new THREE.Mesh(skyGeo, skyMat))
    ball.add(new THREE.Mesh(groundGeo, groundMat))
    const equator = new THREE.Mesh(
      track(new THREE.TorusGeometry(0.552, 0.01, 6, 48)),
      track(new THREE.MeshBasicMaterial({ color: 0x00e5ff })),
    )
    equator.rotation.x = Math.PI / 2
    ball.add(equator)

    // 陀螺转子：绕姿态轴快速自转的环（仿真心）
    const rotor = new THREE.Mesh(
      track(new THREE.TorusGeometry(0.3, 0.02, 8, 32)),
      track(new THREE.MeshStandardMaterial({
        color: 0xd6d1c4, roughness: 0.4, metalness: 0.3,
      })),
    )
    rotor.rotation.x = Math.PI / 2
    ball.add(rotor)

    // 迷你车体线框（固定于球心，车头 +X）
    const rover = new THREE.Mesh(
      track(new THREE.BoxGeometry(0.16, 0.06, 0.1)),
      track(new THREE.MeshBasicMaterial({ color: 0xf5ede6, wireframe: true })),
    )
    scene.add(rover)
    const mast = new THREE.Mesh(
      track(new THREE.BoxGeometry(0.015, 0.07, 0.015)),
      track(new THREE.MeshBasicMaterial({ color: 0xf5ede6, wireframe: true })),
    )
    mast.position.set(0.05, 0.065, 0)
    scene.add(mast)

    // 平滑状态
    const curNormal = new THREE.Vector3(0, 1, 0)
    const tgtQ = new THREE.Quaternion()
    let curYaw = yaw
    const UP = new THREE.Vector3(0, 1, 0)
    const nrm = new THREE.Vector3()

    let raf = 0
    const animate = (now: number) => {
      raf = requestAnimationFrame(animate)
      const t = now / 1000
      const tgt = targetRef.current

      if (tgt.normal) {
        nrm.set(tgt.normal.x, tgt.normal.y, tgt.normal.z).normalize()
        curNormal.lerp(nrm, 0.18).normalize()
      }
      tgtQ.setFromUnitVectors(UP, curNormal)
      ball.quaternion.slerp(tgtQ, 0.35)
      rotor.rotation.y = t * 5 // 转子自转（绕姿态轴）

      // 航向平滑（角度环绕）
      let dy = tgt.yaw - curYaw
      while (dy > Math.PI) dy -= Math.PI * 2
      while (dy < -Math.PI) dy += Math.PI * 2
      curYaw += dy * 0.25
      yawGroup.rotation.y = -curYaw

      renderer.render(scene, camera)
    }
    raf = requestAnimationFrame(animate)
    // 姿态/航向经 targetRef 在每次渲染时同步进动画循环，
    // 组件卸载是本 effect 的唯一依赖变化，故依赖数组为空是有意的
    // eslint-disable-next-line react-hooks/exhaustive-deps

    return () => {
      cancelAnimationFrame(raf)
      for (const d of disposables) d.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement)
      }
    }
    // 姿态/航向经 targetRef 在每次渲染时同步进动画循环，
    // 依赖数组为空是有意的
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div ref={mountRef} style={{ width: SIZE, height: SIZE }} />
}
