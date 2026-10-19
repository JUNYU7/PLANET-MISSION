"""任务规划接口
- 地形查询：坐标 → 地形属性，供前端放置点自动回填
- 任务 CRUD：Mission JSON 的增删查，持久化到
  dataset_repo/missions/<region>/<mission_id>.json
"""

import json
import re
import time
import traceback
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import StreamingResponse

from ..core import terrain_query
from ..env import run_mission
from ..env.live import get_v_scale, set_v_scale
from ..env.policies import ScriptedPursuitPolicy
from ..env.rover_env import RoverEnv, load_mission
from ..env.runner import list_runs, _runs_dir
from ..pipeline.registry import load_meta
from ..settings import MISSIONS_DIR

router = APIRouter(prefix="/api", tags=["missions"])

# mission_id 白名单：小写字母数字下划线，防止路径穿越
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_]{0,63}$")

# 任务类型：RECOVERY 需故障区多边形，
# 操作类需机械臂配置，本阶段不在编辑器开放。
_ALLOWED_TYPES = {"TRAVERSE", "TARGETED_APPROACH", "SURVEY_PATH"}


def _missions_dir(region: str) -> Path:
    return MISSIONS_DIR / region


def _validate_mission(mission: Dict[str, Any], region: str) -> str:
    """轻量校验，返回 mission_id。校验失败抛 HTTPException。"""
    mid = str(mission.get("mission_id", ""))
    if not _SLUG_RE.match(mid):
        raise HTTPException(
            status_code=400,
            detail="mission_id 需为小写字母/数字/下划线（≤64 字符）")
    if str(mission.get("region", "")) != region:
        raise HTTPException(status_code=400, detail="region 与 URL 不一致")
    sols = mission.get("sols")
    if not isinstance(sols, list) or not sols:
        raise HTTPException(status_code=400, detail="sols 不能为空")
    for sol in sols:
        acts = sol.get("activities")
        if not isinstance(acts, list):
            raise HTTPException(status_code=400, detail="activities 缺失")
        for act in acts:
            atype = str(act.get("type", ""))
            if atype not in _ALLOWED_TYPES:
                raise HTTPException(
                    status_code=400,
                    detail="暂不支持的任务类型：%s（当前支持 %s）"
                           % (atype, sorted(_ALLOWED_TYPES)))
            targets = act.get("targets")
            if not isinstance(targets, list) or not targets:
                raise HTTPException(
                    status_code=400,
                    detail="Activity %s 缺少目标点" % act.get("id", "?"))
            for t in targets:
                if not isinstance(t.get("x"), (int, float)) \
                        or not isinstance(t.get("y"), (int, float)):
                    raise HTTPException(
                        status_code=400,
                        detail="Activity %s 存在缺少坐标的目标点"
                               % act.get("id", "?"))
    return mid


@router.get("/regions/{name}/terrain/query")
def get_terrain_query(name: str, x: float, y: float):
    """查询世界坐标 (x 东, y 南) 处的地形属性。"""
    try:
        load_meta(name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return terrain_query.query_at(name, x, y)


@router.get("/regions/{name}/missions")
def list_missions(name: str):
    """列出该区域全部任务（摘要：ID + 名称 + 活动数）。

    仅统计真正的任务定义（含 sols 字段的文件），轨迹 JSON 不计入；
    同一 mission_id 只保留首条，保证列表不出现重复条目。
    """
    d = _missions_dir(name)
    items = []
    seen = set()
    if d.exists():
        for p in sorted(d.glob("*.json")):
            try:
                with open(p, "r", encoding="utf-8") as fh:
                    m = json.load(fh)
                if not isinstance(m.get("sols"), list):
                    continue
                mid = str(m.get("mission_id", p.stem))
                if mid in seen:
                    continue
                seen.add(mid)
                n_acts = sum(len(s.get("activities", []))
                             for s in m.get("sols", []))
                items.append({
                    "mission_id": mid,
                    "name": m.get("name", mid),
                    "activities": n_acts,
                })
            except (ValueError, OSError):
                continue
    return {"missions": items}


@router.get("/regions/{name}/missions/{mid}")
def get_mission(name: str, mid: str):
    path = _missions_dir(name) / ("%s.json" % mid)
    if not path.exists():
        raise HTTPException(status_code=404, detail="任务不存在：%s" % mid)
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


@router.post("/regions/{name}/missions")
def save_mission(name: str, mission: Dict[str, Any] = Body(...)):
    """新建或覆盖保存任务（upsert）。校验通过后落盘。"""
    try:
        load_meta(name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    mid = _validate_mission(mission, name)
    d = _missions_dir(name)
    d.mkdir(parents=True, exist_ok=True)
    path = d / ("%s.json" % mid)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(mission, fh, ensure_ascii=False, indent=2)
    return {"saved": True, "mission_id": mid, "path": str(path)}


@router.delete("/regions/{name}/missions/{mid}")
def delete_mission(name: str, mid: str):
    path = _missions_dir(name) / ("%s.json" % mid)
    if not path.exists():
        raise HTTPException(status_code=404, detail="任务不存在：%s" % mid)
    path.unlink()
    return {"deleted": True, "mission_id": mid}


@router.post("/regions/{name}/missions/{mid}/run")
def post_run_mission(
    name: str,
    mid: str,
    episodes: int = Query(default=1, ge=1, le=20),
    seed: int = Query(default=0),
):
    """运行任务的 surrogate 环境（脚本基线策略），返回指标汇总。
        轨迹写入 dataset_repo/missions/<region>/runs/<mid>/。
    """
    try:
        load_meta(name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    try:
        return run_mission(name, mid, episodes=episodes, seed=seed)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/regions/{name}/missions/{mid}/runs")
def get_mission_runs(name: str, mid: str):
    return {"runs": list_runs(name, mid)}


@router.get("/regions/{name}/missions/{mid}/runs/{filename}")
def get_run_trajectory(name: str, mid: str, filename: str):
    """读取单条轨迹全文（samples/events/targets/metrics），供回放叠加。"""
    if not re.match(r"^[a-z0-9_.\-]+\.json$", filename):
        raise HTTPException(status_code=400, detail="非法文件名")
    path = MISSIONS_DIR / name / "runs" / mid / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="轨迹不存在：%s" % filename)
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


@router.post("/regions/{name}/missions/{mid}/run/live")
def run_live(name: str, mid: str,
             activity_id: str = Query(default=""),
             frame_s: float = Query(default=0.25, ge=0.1, le=5.0),
             seed: int = Query(default=0),
             v_scale: float = Query(default=1.0, ge=0.1, le=10.0)):
    """实时仿真：SSE 逐帧推送小车状态。

    后端按真实 1 倍速运行：每步（0.1 s 仿真）耗时仅数毫秒，
    余量用于睡眠，使仿真时间与墙钟时间同步——前端 1:1 消费即可，
    无需播放倍速，也不会出现「任务结束轨迹还在补」。
    结束推送 done 事件（含指标）并落盘 trajectory.json，可供回放。

    火星车速度：v_scale 为初始倍率（v_max × scale），运行期可用
    POST .../run/live/speed 调整，立即生效。
    """
    try:
        load_meta(name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    try:
        mission = load_mission(name, mid)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))

    activity = None
    for sol in mission.get("sols", []):
        for act in sol.get("activities", []):
            if activity_id and act.get("id") != activity_id:
                continue
            activity = act
            break
        if activity:
            break
    if activity is None:
        raise HTTPException(
            status_code=404,
            detail="未找到 Activity：%s" % (activity_id or "(首个)"))

    def _frame(env: RoverEnv, info: Dict[str, Any],
               photo_events: Optional[List[Dict[str, Any]]] = None,
               radar_points: Optional[List[Any]] = None) -> Dict[str, Any]:
        st = env.state
        prof = env.terrain.local_profile(st.x, st.y, st.yaw)
        sem_names = {0: "unknown", 1: "sand", 2: "bedrock", 3: "boulder",
                     4: "base"}
        ti_names = {0: "不确定", 1: "可通行", 2: "缓行", 3: "禁行"}
        # 最近一次雷达扫描（_obs 已算好，此处仅序列化供前端雷达可视化）
        lidar = getattr(env, "_last_lidar", None)
        frame = {
            "t": round(st.time_s, 2),
            "x": round(st.x, 2),
            "y": round(st.y, 2),
            "yaw": round(st.yaw, 3),
            "v": round(env._last_vel[0] * float(env.p["v_max"]), 3),
            # 实际前进速度（扣除滑转）：供前端轮子驱动，避免滑转时
            # 轮子按指令速度空转、视觉上「疯狂打滑」
            "v_actual": round(getattr(env, "_last_advance", 0.0)
                              / float(env.p["dt"]), 3),
            "w": round(env._last_vel[1] * float(env.p["w_max"]), 3),
            "slip": round(st.slip_ratio, 3),
            "energy_wh": round(st.energy_wh, 3),
            "slope_deg": round(prof["slope"], 2),
            "ti": ti_names[int(prof["ti"])],
            "semantic": sem_names[int(prof["sem"])],
            "height": round(prof["height"], 2),
            "dust_tau": round(env.dust_tau, 2),
            "local_hour": round(env.local_hour, 1),
            "lidar": [round(float(v), 3) for v in lidar]
            if lidar is not None else [],
            "lidar_range": round(float(env.p["lidar_range_m"]), 1),
            "progress": env.progress(),
        }
        # SURVEY_PATH：顶点拍照计数 + 本帧新拍照片
        # 前端据此以火星车相机视角离屏渲染照片
        if env.type == "SURVEY_PATH":
            frame["photos"] = len(env.photos)
            if photo_events:
                frame["photo_events"] = photo_events
        # TARGETED_APPROACH：雷达成像进度 + 本帧新增点云（少量）。
        # phase：spinup（起旋，区域高亮出现）/ scan（扫描中）/ done（结束）。
        if env.type == "TARGETED_APPROACH":
            scan = getattr(env, "_last_scan", None)
            if scan is not None:
                frame["radar"] = {
                    "phase": getattr(env, "phase", "scan"),
                    "coverage": round(float(scan["coverage"]), 4),
                    "sweep": int(scan["sweep"]),
                    "angle": round(float(scan["angle"]), 4),
                    "points": radar_points or [],
                }
        return frame

    def gen():
        try:
            env = RoverEnv(name, activity, seed=seed)
            set_v_scale(v_scale)  # 初始车速倍率
            obs, _ = env.reset()
            pol = ScriptedPursuitPolicy(env)
            next_push = 0.0
            seen_events = 0
            seen_photos = 0
            pending_photos: List[Dict[str, Any]] = []
            pending_radar_pts: List[Any] = []
            t0 = time.monotonic()
            while True:
                # 运行期车速倍率（live/speed 接口可随时调整），下一步生效
                env.set_v_scale(get_v_scale())
                action = pol.act(obs)
                obs, _r, terminated, truncated, info = env.step(action)
                new_events = env.events[seen_events:]
                seen_events = len(env.events)
                # 顶点拍照：累积到下一推送帧（photo_events 含相机位姿）
                if env.type == "SURVEY_PATH" \
                        and len(env.photos) > seen_photos:
                    pending_photos.extend(env.photos[seen_photos:])
                    seen_photos = len(env.photos)
                # 雷达成像：累积本步新增点云（每步仅数十个点）
                scan = getattr(env, "_last_scan", None)
                if env.type == "TARGETED_APPROACH" and scan \
                        and scan.get("points"):
                    pending_radar_pts.extend(scan["points"])
                # 推送判定：到推送时刻，**或本步是最后一步**。后者
                # 不可省略——终止步往往不落在 frame_s 整数倍上，若
                # 不强制推送，最后一张照片的 photo_events、photos
                # 计数与最终车姿会随流关闭一起丢弃，前端表现为
                # 「顶点成像 2/3 且没有第 3 张」（实测）。
                if env.state.time_s >= next_push or terminated or truncated:
                    next_push += frame_s
                    frame = _frame(env, info, pending_photos,
                                   pending_radar_pts)
                    pending_photos = []
                    pending_radar_pts = []
                    frame["events"] = [
                        {"t": e["t"], "type": e["type"]} for e in new_events
                    ]
                    yield "data: %s\n\n" % json.dumps(frame, ensure_ascii=False)
                # 真实 1 倍速：仿真时间不跑赢墙钟时间（单步约 2~3 ms，
                # 余量充足；单次睡眠截断到 0.25 s，卡顿后能较快重新同步）
                ahead = env.state.time_s - (time.monotonic() - t0)
                if ahead > 0.002:
                    time.sleep(min(ahead, 0.25))
                if terminated or truncated:
                    break
            metrics = env.finalize()
            traj = env.export_trajectory(mid)
            runs_dir = _runs_dir(name, mid)
            runs_dir.mkdir(parents=True, exist_ok=True)
            out = runs_dir / ("%s_live.json" % activity.get("id", "act"))
            with open(out, "w", encoding="utf-8") as fh:
                json.dump(traj, fh, ensure_ascii=False)
            yield "event: done\ndata: %s\n\n" % json.dumps(
                {"metrics": metrics, "trajectory_file": out.name},
                ensure_ascii=False)
        except Exception as exc:  # noqa: BLE001
            # 环境异常不得静默断流：显式推送 error 事件，前端据此
            # 提示，而不是表现为「连接被掐断」的 network error
            traceback.print_exc()
            yield "event: error\ndata: %s\n\n" % json.dumps(
                {"message": str(exc)}, ensure_ascii=False)

    return StreamingResponse(gen(), media_type="text/event-stream")


@router.post("/regions/{name}/missions/{mid}/run/live/speed")
def set_live_speed(name: str, mid: str,
                   scale: float = Query(default=1.0, ge=0.1, le=10.0)):
    """运行期调整火星车速度倍率（v_max × scale），下一步立即生效。"""
    try:
        load_meta(name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    path = MISSIONS_DIR / name / ("%s.json" % mid)
    if not path.exists():
        raise HTTPException(status_code=404, detail="任务不存在：%s" % mid)
    return {"scale": set_v_scale(scale)}
