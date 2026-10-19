"""实时仿真（SSE live 流）运行期控制。

前后端均按真实 1 倍速运行：后端以墙钟节流仿真步进，前端 1:1
消费帧，不再有「播放倍速」。「火星车速度」通过本模块在运行期
调整 env 的 v_max（线速度上限），无需重建数据流。

单用户本地工具：全局标量即可，GIL 保证读写原子性。
"""

from __future__ import annotations

_v_scale = 1.0


def set_v_scale(scale: float) -> float:
    """设置车速倍率（v_max × scale），裁剪到 [0.1, 10]。"""
    global _v_scale
    _v_scale = max(0.1, min(10.0, float(scale)))
    return _v_scale


def get_v_scale() -> float:
    return _v_scale
