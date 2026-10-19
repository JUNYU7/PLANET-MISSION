import * as THREE from 'three'

/**
 * 小地图：正交俯视视图。
 *
 * 采用与主场景共用的第二个场景 + 正交相机，通过裁剪区域（scissor test）
 * 渲染到主画布右下角，而不是另开一个渲染器或画布。好处是纹理与几何体
 * 完全共享，无需二次上传显存，且不会出现两个画布的缩放不同步。
 */

export interface MinimapOptions {
  /** 小地图边长（像素） */
  size: number
  /** 覆盖范围（米），指单侧边长的一半 */
  extent: number
  /** 视口小于此宽度时缩小 */
  shrinkBelow: number
  shrinkSize: number
}

export const MINIMAP_PRESET: MinimapOptions = {
  size: 256,
  extent: 150,
  shrinkBelow: 900,
  shrinkSize: 200,
}

export interface Minimap {
  /** 挂载地形与标记，使其在小地图中可见 */
  attachTerrain: (
    texture: THREE.Texture,
    sizeM: number,
  ) => THREE.Mesh
  /** 在主画布上绘制小地图，必须在主场景渲染之后调用 */
  render: (
    renderer: THREE.WebGLRenderer,
    mainCamera: THREE.PerspectiveCamera,
    canvasWidth: number,
    canvasHeight: number,
  ) => void
  dispose: () => void
}

export function createMinimap(opts: MinimapOptions = MINIMAP_PRESET): Minimap {
  const scene = new THREE.Scene()

  // 底色略深于主场景，使小地图在明亮地形上仍有边界感
  scene.background = new THREE.Color(0x141110)

  const camera = new THREE.OrthographicCamera(
    -opts.extent,
    opts.extent,
    opts.extent,
    -opts.extent,
    0.1,
    opts.extent * 8,
  )

  // 顶视：相机置于场景上方并垂直下看。正交相机默认位于原点且朝 -Z，
  // 若不显式设置位置，水平放置的地形面将完全不可见。
  // up 设为 (0,0,-1)，使画面上方对应世界 -Z（北），符合地图习惯。
  const eyeHeight = opts.extent * 2
  camera.up.set(0, 0, -1)
  camera.position.set(0, eyeHeight, 0)
  camera.lookAt(0, 0, 0)

  const hemi = new THREE.HemisphereLight(0xd8c0a8, 0x2a1c14, 1.5)
  scene.add(hemi)
  const dir = new THREE.DirectionalLight(0xffe8d0, 1.1)
  dir.position.set(0.4, 1, 0.6)
  scene.add(dir)

  // 玩家朝向标记：手工构造三角形，尖端位于局部 +Z 轴，
  // 这样 lookAt 会让 +Z 指向目标方向，无需手工推算欧拉角。
  // 用圆锥配合 rotation 会在欧拉顺序上产生歧义，导致朝向不随视角变化。
  const arrowR = opts.extent * 0.045
  const arrowL = opts.extent * 0.085
  const arrowGeo = new THREE.BufferGeometry()
  arrowGeo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [
        0, 0, arrowL * 1.6, // 尖端 +Z
        -arrowR, 0, -arrowL * 0.6,
        arrowR, 0, -arrowL * 0.6,
      ],
      3,
    ),
  )
  arrowGeo.setIndex([0, 1, 2])
  arrowGeo.computeVertexNormals()

  const player = new THREE.Mesh(
    arrowGeo,
    new THREE.MeshBasicMaterial({
      color: 0x00e5ff,
      side: THREE.DoubleSide,
      depthTest: false,
    }),
  )
  player.renderOrder = 20
  scene.add(player)

  return {
    attachTerrain: (texture: THREE.Texture, sizeM: number) => {
      // 贴图直接复用主场景的实例：GPU 上传一次即可，两个场景共享
      const mat = new THREE.MeshBasicMaterial({ map: texture })
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(sizeM, sizeM), mat)
      // 只绕 X 旋转 -90°：PlaneGeometry 的局部 +Y（纹理 v=1，影像顶部
      // 即北）恰好映射到世界 -Z，与主场景轴向约定一致（北 = -Z），
      // 也与小地图四周的 N/S/E/W 标注吻合。此前额外加的
      // rotation.z = π 会把整张图旋转 180°，表现为小地图南北颠倒、
      // 箭头方向与位置相对地物全部对不上。
      plane.rotation.x = -Math.PI / 2
      plane.position.y = 0.1
      scene.add(plane)
      return plane
    },
    render: (renderer, mainCamera, canvasWidth, canvasHeight) => {
      const s = canvasWidth < opts.shrinkBelow ? opts.shrinkSize : opts.size

      camera.left = -opts.extent
      camera.right = opts.extent
      camera.top = opts.extent
      camera.bottom = -opts.extent

      // 标记固定在贴近地表的高度，避免高空时因透视差异偏移
      player.position.set(
        mainCamera.position.x,
        eyeHeight * 0.5,
        mainCamera.position.z,
      )

      // 相机跟随主相机水平位置，实现小地图平移
      camera.position.set(
        mainCamera.position.x,
        eyeHeight,
        mainCamera.position.z,
      )
      camera.lookAt(mainCamera.position.x, 0, mainCamera.position.z)
      camera.updateMatrixWorld()

      // 箭头指向主相机的水平朝向。箭头尖端在局部 +Z，绕 Y 旋转 θ 后
      // 尖端指向 (sinθ, 0, cosθ)，因此 θ = atan2(dir.x, dir.z) 即可让
      // 尖端与实际前进方向严格一致（此前取 -dir.z，南北分量被镜像，
      // 在已修正为北朝上的地图上表现为箭头方向与前进方向不符）。
      const dir = new THREE.Vector3()
      mainCamera.getWorldDirection(dir)
      player.rotation.set(0, Math.atan2(dir.x, dir.z), 0)

      // 视口原点位于左下角（WebGL 约定），边框容器使用 CSS 的 top/left，
      // 因此此处偏移量为「边框到画布左下角」的像素数：左右各 12，
      // 底部 12 + 高度 s。注意 y 起点要减去边框高度。
      const marginX = 12
      const marginY = 12
      const x = canvasWidth - s - marginX
      const y = marginY
      renderer.setScissorTest(true)
      renderer.setViewport(x, y, s, s)
      renderer.setScissor(x, y, s, s)
      renderer.clearDepth()
      renderer.render(scene, camera)
      renderer.setScissorTest(false)
      // 恢复主视口，避免后续渲染被裁剪
      renderer.setViewport(0, 0, canvasWidth, canvasHeight)
    },
    dispose: () => {
      player.geometry.dispose()
      ;(player.material as THREE.Material).dispose()
    },
  }
}