import { useEffect, useState } from 'react'
import {
  deleteMission,
  getMission,
  listMissions,
  saveMission,
} from '../api/client'
import { logEvent } from '../console/events'
import { useApp } from '../store/AppContext'
import type {
  ActivityType,
  Mission,
  MissionActivity,
  MissionSummary,
} from '../types'

const TYPE_LABEL: Record<ActivityType, string> = {
  TRAVERSE: '穿越',
  TARGETED_APPROACH: '抵近',
  SURVEY_PATH: '勘测',
}

/** 类型选择提示（放置规则，随选中类型切换） */
const TYPE_HINT: Record<ActivityType, string> = {
  TRAVERSE: '在地形上点击放置任意多个途经点，点间自动连线',
  TARGETED_APPROACH:
    '点击地形放 1 个目标点即可（车头朝向自动推导为区域中心）；到位后火星车起旋，雷达斜向下扫视并绘制 10 m 半径地形图',
  SURVEY_PATH:
    '依次点击 3 个不共线顶点，自动生成勘测三角区、质心与成像扇面；火星车从质心出发驶向各顶点，停车后相机朝向质点拍照，3 张拍完即完成',
}

const TI_LABEL: Record<number, string> = {
  0: '不确定',
  1: '可通行',
  2: '缓行',
  3: '禁行',
}

const TI_COLOR: Record<number, string> = {
  0: '#8D7B6B',
  1: '#34C759',
  2: '#FFD60A',
  3: '#FF3B30',
}

interface Props {
  activities: MissionActivity[]
  selectedId: string | null
  missionName: string
  saveError: string | null
  /** 写入 saveError（红色提示行），校验失败时给出原因 */
  onSaveError: (msg: string | null) => void
  placementType: ActivityType
  onSelect: (id: string | null) => void
  onDelete: (id: string) => void
  onMove: (id: string, dir: -1 | 1) => void
  onFovChange: (id: string, fov: number) => void
  onPlacementTypeChange: (type: ActivityType) => void
  onNameChange: (name: string) => void
  onLoadMission: (mission: Mission) => void
  /** 实时仿真：先保存再 SSE 运行指定 Activity */
  onStartLive: (mission: Mission, activityId: string) => void
}

/** 任务规划面板（策划书 28.1 流程层）。
 *
 * 双栏结构：「创建任务」（命名 → 选类型 → 地图标记 → 保存）与
 * 「已有的任务」（载入 / 删除 / 排序，顺序持久化到 localStorage）。
 */
export default function TaskPanel({
  activities,
  selectedId,
  missionName,
  saveError,
  onSaveError,
  placementType,
  onSelect,
  onDelete,
  onMove,
  onFovChange,
  onPlacementTypeChange,
  onNameChange,
  onLoadMission,
  onStartLive,
}: Props) {
  const { region, setPlanning } = useApp()
  const [missions, setMissions] = useState<MissionSummary[]>([])
  const [order, setOrder] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  /** 当前草稿来源的已存任务（载入或上次保存）：同名校验其 ID，
   *  避免改名后另存新文件导致「已有的任务」出现重复条目。 */
  const [loaded, setLoaded] = useState<{ id: string; name: string } | null>(
    null,
  )

  const orderKey = region ? `mission_order_${region.meta.name}` : 'mission_order'

  useEffect(() => {
    if (!region) return
    listMissions(region.meta.name)
      .then((d) => {
        // 按 mission_id 去重：同一 ID 只保留首条，防止列表出现重复条目
        const seen = new Set<string>()
        setMissions(d.missions.filter((m) => {
          if (seen.has(m.mission_id)) return false
          seen.add(m.mission_id)
          return true
        }))
        try {
          const saved: string[] = JSON.parse(
            localStorage.getItem(orderKey) ?? '[]',
          )
          setOrder(saved)
        } catch {
          setOrder([])
        }
      })
      .catch(() => setMissions([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region, saved])

  if (!region) return null

  const sortedMissions = [...missions].sort((a, b) => {
    const ia = order.indexOf(a.mission_id)
    const ib = order.indexOf(b.mission_id)
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib)
  })

  const moveSaved = (id: string, dir: -1 | 1) => {
    setOrder((prev) => {
      const ids = sortedMissions.map((m) => m.mission_id)
      const i = ids.indexOf(id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= ids.length) return prev
      ;[ids[i], ids[j]] = [ids[j], ids[i]]
      try {
        localStorage.setItem(orderKey, JSON.stringify(ids))
      } catch {
        /* 忽略持久化失败 */
      }
      return ids
    })
  }

  /**
   * 任务 ID 解析：同名任务复用其 ID（覆盖更新），异名才生成新 ID。
   * 纯中文等名称剥离后为空串，用名称哈希生成稳定 ID——固定回退值
   * "mission" 会让所有中文名互相覆盖，改名后另存新 ID 又会在
   * 「已有的任务」里留下重复条目。
   */
  const resolveMissionId = (name: string): string => {
    const trimmed = name.trim()
    const sameName = missions.find((m) => m.name.trim() === trimmed)
    if (sameName) return sameName.mission_id
    if (loaded && loaded.name.trim() === trimmed) return loaded.id
    const slug = trimmed
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_]/g, '')
      .slice(0, 64)
    if (slug) return slug
    let h = 2166136261
    for (let i = 0; i < trimmed.length; i++) {
      h ^= trimmed.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return 'm' + (h >>> 0).toString(36).slice(0, 8)
  }

  const buildMission = (): Mission => {
    const name = missionName.trim()
    return {
      mission_id: resolveMissionId(name),
      region: region.meta.name,
      name,
      sol_hours: 24.6597,
      sols: [{ sol: 1, activities }],
      success_criteria: 'all_activities_succeeded',
      scoring: 'per_activity_partial_credit',
    }
  }

  /** 前置校验：不满足时把原因写进 saveError（红色提示行），
   *  而不是静默 return——按钮被点击却毫无反馈会被当成「没反应」 */
  const requireReady = () => {
    if (!missionName.trim()) {
      onSaveError('请先填写任务名称')
      return false
    }
    if (activities.length === 0) {
      onSaveError('请先在地形上放置任务点')
      return false
    }
    return true
  }

  const handleSave = async () => {
    if (!requireReady()) return
    setSaving(true)
    setSaved(null)
    try {
      const mission = buildMission()
      await saveMission(region.meta.name, mission)
      setLoaded({ id: mission.mission_id, name: mission.name ?? '' })
      setSaved(`已保存：${missionName.trim()}`)
      onSaveError(null)
      logEvent(
        'sys',
        `任务已保存：「${mission.name}」（${activities.length} 个步骤）`,
      )
    } catch (e) {
      setSaved(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const handleStartLive = () => {
    if (!requireReady()) return
    const mission = buildMission()
    // 默认跑列表中选中的 Activity，未选中则跑第一个
    const actId = selectedId ?? activities[0]?.id ?? ''
    onStartLive(mission, actId)
  }

  const handleLoad = async (id: string) => {
    try {
      const m = await getMission(region.meta.name, id)
      setLoaded({ id, name: m.name ?? '' })
      onLoadMission(m)
    } catch (e) {
      console.error('加载任务失败', e)
    }
  }

  const handleDeleteSaved = async (id: string) => {
    try {
      await deleteMission(region.meta.name, id)
      setMissions((prev) => prev.filter((m) => m.mission_id !== id))
    } catch (e) {
      console.error('删除任务失败', e)
    }
  }

  /** 当前放置进度提示（按类型规则） */
  const placementProgress = () => {
    if (placementType === 'TRAVERSE') {
      const n =
        [...activities].reverse().find((a) => a.type === 'TRAVERSE')
          ?.targets.length ?? 0
      return n === 0 ? '点击地形放置第 1 个途经点' : `已放 ${n} 个途经点，可继续点击追加`
    }
    if (placementType === 'TARGETED_APPROACH') {
      const n = activities.filter((a) => a.type === 'TARGETED_APPROACH').length
      return n === 0
        ? '点击地形放置目标点（每次点击新建一个抵近任务）'
        : `已放 ${n} 个目标点，可继续点击追加`
    }
    const open = [...activities]
      .reverse()
      .find(
        (a) =>
          a.type === 'SURVEY_PATH' &&
          a.targets.filter((t) => t.role === 'vertex').length < 3,
      )
    if (!open) return '点击地形放置第 1 个顶点'
    const n = open.targets.filter((t) => t.role === 'vertex').length
    return `已放 ${n}/3 个顶点`
  }

  return (
    <aside className="w-[280px] shrink-0 bg-ink-800 border-l border-ink-600 overflow-y-auto flex flex-col pb-7">
      <div className="panel-header flex items-center justify-between">
        <span>任务规划</span>
        <button
          type="button"
          className="text-bone-faint hover:text-rust-bright transition-colors text-xs normal-case tracking-normal"
          onClick={() => setPlanning(false)}
        >
          退出
        </button>
      </div>

      {/* ── 创建任务 ── */}
      <div className="px-3 pt-2 pb-1 text-[10px] text-bone-faint uppercase tracking-wider">
        创建任务
      </div>

      <div className="px-3 pb-2">
        <input
          type="text"
          value={missionName}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="任务名称"
          className="w-full bg-ink-700 border border-ink-500 px-2 py-1.5 text-sm text-bone
            focus:outline-none focus:border-rust-muted"
        />
      </div>

      {/* 任务类型：先选类型，再地图标记 */}
      <div className="px-3 pb-2">
        <div className="flex mb-1.5">
          {(Object.keys(TYPE_LABEL) as ActivityType[]).map((k) => (
            <button
              key={k}
              type="button"
              className={`btn flex-1 ${placementType === k ? 'btn-active' : ''}`}
              onClick={() => onPlacementTypeChange(k)}
            >
              {TYPE_LABEL[k]}
            </button>
          ))}
        </div>
        <p className="num text-[10px] text-bone-faint leading-relaxed">
          {TYPE_HINT[placementType]}
          <br />
          {placementProgress()}
        </p>
      </div>

      {/* 草稿步骤列表（空间/流程层双向联动） */}
      <div className="border-t border-ink-600">
        {activities.length === 0 && (
          <p className="text-xs text-bone-faint px-3 py-3 leading-relaxed">
            尚无步骤。选择类型后在地图上点击放置。
          </p>
        )}
        {activities.map((act, idx) => {
          const t = act.targets[0]
          const tq = t?.terrain_query
          const selected = act.id === selectedId
          const nVerts = act.targets.filter((x) => x.role === 'vertex').length
          return (
            <div
              key={act.id}
              onClick={() => onSelect(selected ? null : act.id)}
              className={`px-3 py-2 border-b border-ink-700 cursor-pointer transition-colors ${
                selected ? 'bg-ink-600' : 'hover:bg-ink-700/60'
              }`}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="num text-xs text-signal-marker shrink-0">
                  {String(idx + 1).padStart(2, '0')}
                </span>
                <span className="text-xs text-bone flex-1 mx-2">
                  {TYPE_LABEL[act.type]}
                </span>
                <button
                  type="button"
                  title="上移"
                  onClick={(e) => {
                    e.stopPropagation()
                    onMove(act.id, -1)
                  }}
                  className="text-bone-faint hover:text-bone text-xs px-1"
                >
                  ↑
                </button>
                <button
                  type="button"
                  title="下移"
                  onClick={(e) => {
                    e.stopPropagation()
                    onMove(act.id, 1)
                  }}
                  className="text-bone-faint hover:text-bone text-xs px-1"
                >
                  ↓
                </button>
                <button
                  type="button"
                  title="删除"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDelete(act.id)
                  }}
                  className="text-bone-faint hover:text-signal-forbid text-xs px-1"
                >
                  ✕
                </button>
              </div>
              <div className="num text-[10px] text-bone-faint mt-1 leading-relaxed">
                {act.type === 'TRAVERSE' && `${act.targets.length} 个途经点`}
                {act.type === 'TARGETED_APPROACH' && '目标点（朝向自动推导）'}
                {act.type === 'SURVEY_PATH' &&
                  `${nVerts}/3 顶点${nVerts === 3 ? ' + 质心' : ''}`}
                {tq && t?.role !== 'orientation' && t?.role !== 'centroid' && (
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span
                      className="w-1.5 h-1.5 inline-block"
                      style={{ backgroundColor: TI_COLOR[tq.ti_class] }}
                    />
                    {TI_LABEL[tq.ti_class]} · 坡度 {tq.slope_deg.toFixed(1)}°
                    · {tq.semantic}
                  </div>
                )}
              </div>
              {/* SURVEY 视角控制 */}
              {act.type === 'SURVEY_PATH' && nVerts === 3 && (
                <div
                  className="flex items-center gap-2 mt-1.5"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="num text-[10px] text-bone-faint shrink-0">
                    视角
                  </span>
                  <input
                    type="range"
                    min={20}
                    max={120}
                    step={5}
                    value={act.fov ?? 60}
                    onChange={(e) => onFovChange(act.id, Number(e.target.value))}
                    className="flex-1"
                  />
                  <span className="num text-[10px] text-bone-dim w-8 text-right">
                    {act.fov ?? 60}°
                  </span>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="p-3 border-t border-ink-600">
        <button
          type="button"
          disabled={saving}
          onClick={() => void handleSave()}
          className="btn w-full mb-1.5 disabled:opacity-50"
        >
          {saving ? '保存中…' : '保存任务'}
        </button>
        <button
          type="button"
          onClick={handleStartLive}
          className="btn w-full"
          title="实时仿真：地图上观看火星车行驶，遥测弹窗显示状态"
        >
          开始仿真
        </button>
        <p className="num text-[10px] text-bone-faint mt-1.5 leading-relaxed">
          「开始仿真」在地图上实时观看火星车行驶（默认跑选中的步骤）；
          遥测面板可调火星车速度与相机跟随。
        </p>
        {saveError && (
          <p className="num text-[10px] text-rust-bright mt-1.5 break-all">
            {saveError}
          </p>
        )}
        {saved && !saveError && (
          <p className="num text-[10px] text-signal-pass mt-1.5">{saved}</p>
        )}
      </div>

      {/* ── 已有的任务 ── */}
      <div className="border-t border-ink-600">
        <div className="px-3 pt-2 pb-1 text-[10px] text-bone-faint uppercase tracking-wider">
          已有的任务
        </div>
        {sortedMissions.length === 0 && (
          <p className="text-xs text-bone-faint px-3 py-3">
            尚无已保存任务。
          </p>
        )}
        {sortedMissions.map((m) => (
          <div
            key={m.mission_id}
            className="flex items-center gap-1 px-3 py-1.5 hover:bg-ink-700/60"
          >
            <button
              type="button"
              title="上移"
              onClick={() => moveSaved(m.mission_id, -1)}
              className="text-bone-faint hover:text-bone text-xs px-0.5"
            >
              ↑
            </button>
            <button
              type="button"
              title="下移"
              onClick={() => moveSaved(m.mission_id, 1)}
              className="text-bone-faint hover:text-bone text-xs px-0.5"
            >
              ↓
            </button>
            <button
              type="button"
              onClick={() => handleLoad(m.mission_id)}
              className="text-xs text-bone-dim hover:text-bone text-left flex-1 truncate"
              title="点击载入"
            >
              {m.name} ({m.activities} 步)
            </button>
            <button
              type="button"
              onClick={() => handleDeleteSaved(m.mission_id)}
              className="text-bone-faint hover:text-signal-forbid text-xs px-1"
              title="删除"
            >
              ✕
            </button>
          </div>
        ))}
        <p className="num text-[10px] text-bone-faint px-3 pb-2 leading-relaxed">
          点击名称载入到「创建任务」；顺序自动记忆。
        </p>
      </div>
    </aside>
  )
}
