"""训练环境包（策划书第 20 章：Surrogate 巡视器）。

v1 = Python surrogate（本包实现）；v2 = Gazebo 物理后端（预留，
同一 gym 风格接口，上层代码零改动）。环境由 Mission JSON 的
Activity 驱动，观测 / 奖励 / 终止 / 随机化配置来自 training 块。
"""

from .rover_env import RoverEnv, load_mission
from .runner import list_runs, run_mission
from .policies import ScriptedPursuitPolicy, run_episode
from .terrain import RegionTerrain
from .rover_model import FaultZone, RoverModel, RoverState

__all__ = [
    "RoverEnv",
    "load_mission",
    "run_mission",
    "list_runs",
    "ScriptedPursuitPolicy",
    "run_episode",
    "RegionTerrain",
    "FaultZone",
    "RoverModel",
    "RoverState",
]
