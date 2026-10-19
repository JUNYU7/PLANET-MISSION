"""CLI：运行任务的 surrogate 训练环境（脚本基线策略）。

用法：
    python backend/tools/run_mission.py --region jezero_landing_site \
        --mission m_xxx --episodes 3 --seed 42

输出：每个 Activity 每个 episode 的指标表，轨迹写入
dataset_repo/missions/<region>/runs/<mission>/<activity>_ep<k>.json。
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.app.env import run_mission  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description="运行 surrogate 训练环境")
    ap.add_argument("--region", default="jezero_landing_site")
    ap.add_argument("--mission", required=True, help="mission_id")
    ap.add_argument("--episodes", type=int, default=1)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    try:
        result = run_mission(args.region, args.mission,
                             episodes=args.episodes, seed=args.seed)
    except FileNotFoundError as exc:
        print("[错误] %s" % exc)
        return 1

    print("[任务] %s · 区域 %s · 每活动 %d 个 episode"
          % (result["mission_id"], result["region"],
             result["episodes_per_activity"]))
    for act in result["activities"]:
        print("  Activity %s (%s)" % (act["activity_id"], act["type"]))
        for i, m in enumerate(act["episodes"]):
            print("    ep%-2d %-9s 用时 %6.1fs  路径 %7.1fm  SPL %s  "
                  "碰撞 %d  滑转 %d  能量 %.3fWh"
                  % (i,
                     "成功" if m["success"] else m["terminated_reason"],
                     m["time_s"], m["path_len_m"],
                     ("%.3f" % m["spl"]) if m["spl"] else "  —  ",
                     m["collisions"], m["slip_events"], m["energy_wh"]))
    print("轨迹文件 %d 个，已写入 %s"
          % (len(result["trajectory_files"]),
             Path(result["trajectory_files"][0]).parent
             if result["trajectory_files"] else "-"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
