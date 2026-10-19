"""任务运行器：按 Mission 定义批量跑 episode，落盘轨迹与指标。

CLI（backend/tools/run_mission.py）与 API（POST .../missions/{id}/run）
共用本模块，保证两条入口行为一致。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..settings import MISSIONS_DIR
from .policies import run_episode
from .rover_env import RoverEnv, load_mission

__all__ = ["run_mission", "list_runs"]


def _runs_dir(region: str, mission_id: str) -> Path:
    return MISSIONS_DIR / region / "runs" / mission_id


def run_mission(region: str, mission_id: str, episodes: int = 1,
                seed: int = 0,
                out_root: Optional[Path] = None) -> Dict[str, Any]:
    """运行任务的全部 Activity，返回指标汇总与轨迹文件清单。"""
    mission = load_mission(region, mission_id)
    episodes = max(1, int(episodes))
    runs_root = out_root or _runs_dir(region, mission_id)
    runs_root.mkdir(parents=True, exist_ok=True)

    results: List[Dict[str, Any]] = []
    files: List[str] = []
    ep_idx = 0
    for sol in mission.get("sols", []):
        for activity in sol.get("activities", []):
            ep_metrics: List[Dict[str, Any]] = []
            for k in range(episodes):
                ep_seed = seed + ep_idx
                env = RoverEnv(region, activity, seed=ep_seed)
                metrics, _traj = run_episode(env)
                traj = env.export_trajectory(mission_id)
                out = runs_root / ("%s_ep%d.json" % (activity["id"], k))
                with open(out, "w", encoding="utf-8") as fh:
                    json.dump(traj, fh, ensure_ascii=False)
                files.append(str(out))
                ep_metrics.append(metrics)
                ep_idx += 1
            results.append({
                "activity_id": activity.get("id", ""),
                "type": activity.get("type", ""),
                "episodes": ep_metrics,
            })

    return {
        "mission_id": mission_id,
        "region": region,
        "episodes_per_activity": episodes,
        "activities": results,
        "trajectory_files": files,
    }


def list_runs(region: str, mission_id: str) -> List[Dict[str, Any]]:
    """列出已保存的轨迹文件（含关键指标，供回放与报告使用）。"""
    d = _runs_dir(region, mission_id)
    items: List[Dict[str, Any]] = []
    if not d.exists():
        return items
    for p in sorted(d.glob("*.json")):
        try:
            with open(p, "r", encoding="utf-8") as fh:
                traj = json.load(fh)
            m = traj.get("metrics", {})
            items.append({
                "file": p.name,
                "activity_id": traj.get("activity_id", ""),
                "type": traj.get("type", ""),
                "success": m.get("success"),
                "time_s": m.get("time_s"),
                "collisions": m.get("collisions"),
            })
        except (ValueError, OSError):
            continue
    return items
