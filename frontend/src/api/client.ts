import type {
  GlobeMeta,
  LayerId,
  LiveDone,
  LiveFrame,
  Mission,
  MissionSummary,
  QualityTier,
  RegionDetail,
  RegionSummary,
  TerrainQuery,
} from '../types'

const BASE = '/api'

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path)
  if (!res.ok) {
    const detail = await res.text()
    console.error('请求失败', path, res.status, detail)
    throw new Error(`${path} 返回 ${res.status}`)
  }
  return (await res.json()) as T
}

export function fetchRegions(): Promise<{ regions: RegionSummary[] }> {
  return getJson('/regions')
}

export function fetchRegionDetail(name: string): Promise<RegionDetail> {
  return getJson(`/regions/${name}`)
}

export function fetchGlobeMeta(): Promise<GlobeMeta> {
  return getJson('/globe/meta')
}

export function globeTextureUrl(): string {
  return `${BASE}/globe/texture`
}

export function layerUrl(region: string, filename: string, version?: string): string {
  const base = `${BASE}/regions/${region}/assets/${filename}`
  // 资产响应带 max-age=3600，文件名却固定不变——管线重跑后浏览器
  // 会继续用旧贴图。附加 meta.generated_at 作版本号，重跑即失效。
  return version ? `${base}?v=${encodeURIComponent(version)}` : base
}

export function heightUrl(region: string, filename: string, version?: string): string {
  return layerUrl(region, filename, version)
}

/** 程序化岩石实例清单（后端 core/rocks.py 生成，供前端 InstancedMesh） */
export function rocksUrl(region: string, version?: string): string {
  const base = `${BASE}/regions/${region}/assets/rocks.json`
  return version ? `${base}?v=${encodeURIComponent(version)}` : base
}

/**
 * 加载高程二进制并解析为 Float32Array。
 *
 * 后端输出的是 Float32 原始字节（小端序，与浏览器 TypedArray 一致），
 * 因此可直接构造视图而无需逐字节拷贝。
 */
export async function fetchHeightField(
  region: string,
  filename: string,
  grid: number,
  version?: string,
): Promise<Float32Array> {
  const res = await fetch(heightUrl(region, filename, version))
  if (!res.ok) {
    console.error('高程加载失败', filename, res.status)
    throw new Error(`高程加载失败：${filename}`)
  }
  const buf = await res.arrayBuffer()
  const expect = grid * grid * 4
  if (buf.byteLength !== expect) {
    console.error('高程字节数异常', buf.byteLength, '期望', expect)
    throw new Error(`高程数据长度异常：${buf.byteLength}，期望 ${expect}`)
  }
  return new Float32Array(buf)
}

export function findLayer(
  detail: RegionDetail,
  tier: QualityTier,
  id: LayerId,
) {
  return detail.manifest[tier].layers.find((l) => l.id === id)
}

/** Gazebo 仿真包下载地址（直接触发浏览器下载）。 */
export function gazeboPackageUrl(
  name: string,
  fmt: 'zip' | 'tar.gz' = 'zip',
): string {
  return `${BASE}/regions/${name}/gazebo/package?format=${fmt}`
}

/**
 * 触发后端导出（确保包为最新），再返回。前端随后用 gazeboPackageUrl
 * 触发下载。导出包只含地图（地形 + 光照 + 可选任务标记），不含巡视器/传感器。
 */
export async function exportGazeboPackage(
  name: string,
  opts: { mesh_grid?: number } = {},
): Promise<void> {
  const params = new URLSearchParams()
  if (opts.mesh_grid) params.set('mesh_grid', String(opts.mesh_grid))
  const res = await fetch(`${BASE}/regions/${name}/export/gazebo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })
  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`${res.status}: ${detail}`)
  }
}

/** 地形查询（第 21 章）：x 东、y 南，返回地形属性。 */
export function terrainQuery(
  region: string,
  x: number,
  y: number,
): Promise<TerrainQuery> {
  return getJson(`/regions/${region}/terrain/query?x=${x}&y=${y}`)
}

/** 任务 CRUD（第 19 章 Mission JSON Schema）。 */
export function listMissions(
  region: string,
): Promise<{ missions: MissionSummary[] }> {
  return getJson(`/regions/${region}/missions`)
}

export async function saveMission(
  region: string,
  mission: Mission,
): Promise<void> {
  const res = await fetch(`${BASE}/regions/${region}/missions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mission),
  })
  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`保存任务失败：${detail}`)
  }
}

export function getMission(region: string, id: string): Promise<Mission> {
  return getJson(`/regions/${region}/missions/${id}`)
}

export interface LiveRunHandlers {
  onFrame: (frame: LiveFrame) => void
  onDone: (done: LiveDone) => void
  onError: (message: string) => void
}

/**
 * 实时仿真（SSE）。先保存任务，再以 fetch 读取事件流（EventSource
 * 不支持 POST，故手动解析 SSE 帧）。返回 abort 函数供提前中止。
 *
 * 后端按真实 1 倍速运行（仿真时间同步墙钟），前端 1:1 消费帧；
 * v_scale 为火星车初始速度倍率（v_max × scale）。
 */
export function startLiveRun(
  region: string,
  mission: Mission,
  activityId: string,
  handlers: LiveRunHandlers,
  opts: { frame_s?: number; seed?: number; v_scale?: number } = {},
): () => void {
  const controller = new AbortController()

  const run = async () => {
    try {
      await saveMission(region, mission)
      const params = new URLSearchParams({
        activity_id: activityId,
        frame_s: String(opts.frame_s ?? 0.25),
        seed: String(opts.seed ?? 0),
        v_scale: String(opts.v_scale ?? 1),
      })
      const res = await fetch(
        `${BASE}/regions/${region}/missions/${mission.mission_id}/run/live?${params}`,
        { method: "POST", signal: controller.signal },
      )
      if (!res.ok || !res.body) {
        handlers.onError(`实时仿真启动失败：${res.status}`)
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ""
      let eventType = "message"
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        // SSE 以空行分帧；可能一 chunk 含多帧
        let idx: number
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          const dataLines: string[] = []
          for (const line of raw.split("\n")) {
            if (line.startsWith("event:")) {
              eventType = line.slice(6).trim()
            } else if (line.startsWith("data:")) {
              dataLines.push(line.slice(5).trim())
            }
          }
          if (dataLines.length === 0) continue
          const payload = dataLines.join("\n")
          if (eventType === "done") {
            try {
              handlers.onDone(JSON.parse(payload) as LiveDone)
            } catch {
              handlers.onError("结束帧解析失败")
            }
            eventType = "message"
          } else if (eventType === "error") {
            let msg = "仿真环境异常"
            try {
              msg = (JSON.parse(payload) as { message?: string }).message ?? msg
            } catch {
              /* 保持默认消息 */
            }
            handlers.onError(`仿真环境异常：${msg}`)
            eventType = "message"
            return
          } else {
            try {
              handlers.onFrame(JSON.parse(payload) as LiveFrame)
            } catch {
              /* 忽略坏帧 */
            }
          }
        }
      }
      // 流结束未收到 done（服务端异常）时由调用方超时兜底
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        handlers.onError((e as Error).message || "连接中断")
      }
    }
  }
  void run()
  return () => controller.abort()
}

/** 运行期调整火星车速度倍率（v_max × scale），下一步立即生效。 */
export async function setLiveRoverSpeed(
  region: string,
  missionId: string,
  scale: number,
): Promise<void> {
  const res = await fetch(
    `${BASE}/regions/${region}/missions/${missionId}/run/live/speed?scale=${scale}`,
    { method: 'POST' },
  )
  if (!res.ok) throw new Error(`速度调节失败：${res.status}`)
}

export async function deleteMission(
  region: string,
  id: string,
): Promise<void> {
  const res = await fetch(`${BASE}/regions/${region}/missions/${id}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(`删除任务失败 ${res.status}`)
}