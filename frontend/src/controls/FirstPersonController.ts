import * as THREE from 'three'
import type { HeightField } from '../types'
import { heightAt } from '../scene/heightField'

export type MoveMode = 'ground' | 'fly'

export interface FirstPersonOptions {
  /** 默认眼高（米）。巡视器视角约 2 m */
  eyeHeight: number
  /** 贴地模式下视点可抬高到的上限（米） */
  maxEyeHeight: number
  /** 飞行模式垂直速度（米/秒） */
  flySpeed: number
  /** 地面模式水平移动速度（米/秒） */
  groundSpeed: number
  /** 加速倍率 */
  boostFactor: number
}

export const FP_PRESET: FirstPersonOptions = {
  eyeHeight: 2.0,
  maxEyeHeight: 80,
  flySpeed: 14,
  groundSpeed: 22,
  boostFactor: 3,
}

export type ViewMode = 'orbit' | 'first'

export interface FirstPersonController {
  enable: () => void
  disable: () => void
  isEnabled: () => boolean
  /** 在两种视角模式间切换，等价于按 V */
  toggleView: () => ViewMode
  getViewMode: () => ViewMode
  toggleFly: () => MoveMode
  getMode: () => MoveMode
  getEyeHeight: () => number
  update: (dt: number) => void
  dispose: () => void
}

/**
 * 第一人称漫游控制器。
 *
 * 贴地模式下高度由高程场双线性插值求得，与渲染网格同源，因此不会出现
 * 「视觉上在地表之上、实际已陷入地下」的错位。这里不使用射线求交：
 * 百万顶点网格逐帧 raycast 会掉帧，且插值精度更高。
 *
 * 采用指针锁定实现鼠标转向；未锁定时点击画布重新锁定。
 */
export function createFirstPerson(
  camera: THREE.PerspectiveCamera,
  domElement: HTMLElement,
  hf: HeightField,
  opts: FirstPersonOptions = FP_PRESET,
  /** 读取当前的垂直夸张系数，供高度查询使用 */
  getExaggeration: () => number = () => 1,

  /** 当前太阳方向（世界坐标），用于把初始朝向设为侧对太阳 */
  getSunDir: () => THREE.Vector3 | null = () => null,
  /** 视角切换回调：true=进入第一人称，false=回到环绕视角。
   *  供外部同步 OrbitControls 的启用状态——V 键切换发生在控制器内部，
   *  若外部不知情，退出第一人称后环绕控制会保持禁用，场景无法拖动。 */
  onViewChange: (firstPerson: boolean) => void = () => {},
): FirstPersonController {
  const sunDir = getSunDir()
  const keys = new Set<string>()
  const exag = () => getExaggeration()
  const velocity = new THREE.Vector3()
  const euler = new THREE.Euler(0, 0, 0, 'YXZ')
  const forward = new THREE.Vector3()
  const right = new THREE.Vector3()

  let enabled = false
  let mode: MoveMode = 'ground'
  /** 飞行模式下的离地高度（米） */
  let flyHeight = 0
  /** 贴地模式下的视点高度（米），可在眼高与上限间调整 */
  let eyeHeight = opts.eyeHeight

  function enable(): void {
    enabled = true
    mode = 'ground'
    eyeHeight = opts.eyeHeight
    keys.clear()
    // 主动清除页面焦点：进入第一人称前若焦点残留在某个按钮上
    //（如顶栏「区域场景」、下载按钮），按空格会触发该按钮的点击
    // 默认行为，造成重复导出/重新进入区域等意外场景重建。
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
    // 初始朝向侧对太阳，使受光面与背光面同时入画。
    // 若继承环绕视角的方位角，可能恰好背光，导致画面整体偏暗、
    // 地形起伏难以判读——这在视觉上容易被误认为「没有光照」。
    if (sunDir) {
      const sx = Math.abs(sunDir.x)
      const sz = Math.abs(sunDir.z)
      if (sx > 1e-6 || sz > 1e-6) {
        euler.set(0, Math.atan2(-sunDir.x, -sunDir.z), 0, 'YXZ')
      } else {
        euler.setFromQuaternion(camera.quaternion, 'YXZ')
      }
    } else {
      euler.setFromQuaternion(camera.quaternion, 'YXZ')
    }

    // 环绕视角的相机可能停在场景之外（|x| 或 |z| 超过半边长），
    // 此时高度查询返回 -9999，贴地逻辑不会更新 y，表现为进入第一人称后
    // 相机悬空或埋入地形。此处先做一次就位校正：出界则回到场景中心，
    // 并立即按该点地形高度设置视点高度。
    const half = hf.size / 2
    if (
      Math.abs(camera.position.x) > half ||
      Math.abs(camera.position.z) > half
    ) {
      camera.position.set(0, 0, 0)
      euler.set(0, 0, 0, 'YXZ')
    }
    const g0 = heightAt(hf, camera.position.x, camera.position.z, exag())
    if (g0 !== -9999) {
      camera.position.y = g0 + eyeHeight
    }

    domElement.style.cursor = 'none'
    // 进入场景时启用第一人称没有用户手势，requestPointerLock 会被浏览器
    // 拒绝（新浏览器返回 rejected Promise）。静默处理：用户点击画布后
    // 由 onClick 重新锁定，此时已有手势，必定成功。
    const lock = domElement.requestPointerLock() as unknown as
      | Promise<void>
      | undefined
    if (lock && typeof lock.catch === 'function') lock.catch(() => {})
    onViewChange(true)
  }

  function disable(): void {
    enabled = false
    keys.clear()
    domElement.style.cursor = 'default'
    if (document.pointerLockElement === domElement) {
      document.exitPointerLock()
    }
    onViewChange(false)
  }

  const onKeyDown = (ev: KeyboardEvent) => {
    // 第一人称下屏蔽空格与方向键的页面默认行为（滚动页面、
    // 激活聚焦的按钮）：空格专用于上升，误触发按钮点击会导致
    // 场景意外重建。preventDefault 对 keyup 触发的按钮激活同样生效。
    if (
      enabled &&
      (ev.code === 'Space' || ev.code.startsWith('Arrow'))
    ) {
      ev.preventDefault()
    }
    // V 在两种视角模式间切换，F 在贴地/飞行间切换。
    // 两者都绑定在 window 上，避免焦点位于面板控件时失效。
    if (ev.repeat) {
      keys.add(ev.code)
      return
    }
    if (ev.code === 'KeyV') {
      if (enabled) disable()
      else enable()
      return
    }
    if (ev.code === 'KeyF' && enabled) {
      toggleFly()
      return
    }
    keys.add(ev.code)
  }
  const onKeyUp = (ev: KeyboardEvent) => keys.delete(ev.code)

  const onMouseMove = (ev: MouseEvent) => {
    if (!enabled || document.pointerLockElement !== domElement) return
    const s = 0.0022
    euler.y -= ev.movementX * s
    euler.x -= ev.movementY * s
    euler.x = Math.max(-Math.PI / 2 + 0.02, Math.min(Math.PI / 2 - 0.02, euler.x))
  }

  // 画布点击仅用于重新获取指针锁定，不再切换视角模式，
  // 避免调整视角时误触导致视角跳变。
  const onClick = () => {
    if (enabled && document.pointerLockElement !== domElement) {
      void domElement.requestPointerLock()
    }
  }

  const onLockChange = () => {
    if (!enabled && document.pointerLockElement === domElement) {
      document.exitPointerLock()
    }
  }

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('pointerlockchange', onLockChange)
  domElement.addEventListener('click', onClick)

  function toggleFly(): MoveMode {
    mode = mode === 'ground' ? 'fly' : 'ground'
    if (mode === 'fly') {
      const ground = heightAt(hf, camera.position.x, camera.position.z, exag())
      flyHeight = camera.position.y - (ground === -9999 ? 0 : ground)
      if (flyHeight < 2) flyHeight = 2
    } else {
      // 回到贴地模式时把视点高度同步为当前离地高度，
      // 避免出现瞬间跳落到默认眼高的突兀感。
      const ground = heightAt(hf, camera.position.x, camera.position.z, exag())
      const base = ground === -9999 ? 0 : ground
      eyeHeight = Math.max(
        1.5,
        Math.min(opts.maxEyeHeight, camera.position.y - base),
      )
    }
    return mode
  }

  return {
    enable,
    disable,
    isEnabled: () => enabled,
    toggleView: () => {
      if (enabled) disable()
      else enable()
      return enabled ? 'first' : 'orbit'
    },
    getViewMode: () => (enabled ? 'first' : 'orbit'),
    toggleFly,
    getMode: () => mode,
    getEyeHeight: () => eyeHeight,
    update: (dt: number) => {
      if (!enabled) return

      camera.quaternion.setFromEuler(euler)

      camera.getWorldDirection(forward)
      forward.y = 0
      if (forward.lengthSq() < 1e-8) forward.set(0, 0, -1)
      forward.normalize()
      right.crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize()

      // 加速改用 Ctrl：Shift 专用于下降，两键语义不再冲突
      const boost =
        keys.has('ControlLeft') || keys.has('ControlRight')
          ? opts.boostFactor
          : 1

      velocity.set(0, 0, 0)
      if (keys.has('KeyW') || keys.has('ArrowUp')) velocity.add(forward)
      if (keys.has('KeyS') || keys.has('ArrowDown')) velocity.sub(forward)
      if (keys.has('KeyD') || keys.has('ArrowRight')) velocity.add(right)
      if (keys.has('KeyA') || keys.has('ArrowLeft')) velocity.sub(right)

      // Space 上升、Shift 下降在两种模式下都生效。
      // 贴地模式下表现为抬高/降低视点高度（仍是漫游器视角），
      // 飞行模式下为离地高度的自由升降。
      const up = keys.has('Space')
      const down = keys.has('ShiftLeft') || keys.has('ShiftRight')

      if (mode === 'fly') {
        const speed = opts.flySpeed * boost
        const horizontal = velocity.multiplyScalar(speed * 0.6)
        if (up) flyHeight += speed * dt
        if (down) flyHeight -= speed * dt
        flyHeight = Math.max(flyHeight, 0.5)

        const ground = heightAt(hf, camera.position.x, camera.position.z, exag())
        const base = ground === -9999 ? 0 : ground
        camera.position.x += horizontal.x * dt
        camera.position.z += horizontal.z * dt
        camera.position.y = base + flyHeight
      } else {
        const speed = opts.groundSpeed * boost
        const horizontal = velocity.multiplyScalar(speed)
        camera.position.x += horizontal.x * dt
        camera.position.z += horizontal.z * dt

        if (up) eyeHeight += opts.groundSpeed * boost * 0.6 * dt
        if (down) eyeHeight -= opts.groundSpeed * boost * 0.6 * dt
        eyeHeight = Math.max(1.5, Math.min(opts.maxEyeHeight, eyeHeight))

        const ground = heightAt(hf, camera.position.x, camera.position.z, exag())
        if (ground !== -9999) {
          camera.position.y = ground + eyeHeight
        }
      }
    },
    dispose: () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('pointerlockchange', onLockChange)
      domElement.removeEventListener('click', onClick)
    },
  }
}