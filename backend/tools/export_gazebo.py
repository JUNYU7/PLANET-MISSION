"""CLI：导出某个区域的 Gazebo/ROS2 地图包（只含地形，无巡视器/传感器）。

用法：
    python backend/tools/export_gazebo.py --name jezero_landing_site
    python backend/tools/export_gazebo.py --name jezero_landing_site \
        --mesh-grid 257 --tex-size 4096
    python backend/tools/export_gazebo.py --name jezero_landing_site --zip
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.app.pipeline import gazebo_export  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description="导出 Gazebo/ROS2 地图包（仅地形）")
    ap.add_argument("--name", default="jezero_landing_site",
                    help="区域名（与 regions_index 一致）")
    ap.add_argument("--mesh-grid", type=int, default=257,
                    help="地形碰撞网格分辨率（默认 257）")
    ap.add_argument("--visual-mesh-grid", type=int, default=1025,
                    help="地形视觉网格分辨率（默认 1025）")
    ap.add_argument("--tex-size", type=int, default=4096,
                    help="火星贴图分辨率（默认 4096）")
    ap.add_argument("--zip", action="store_true",
                    help="导出后顺带打成 zip 压缩包")
    ap.add_argument("--out", default=None,
                    help="自定义输出目录（默认 dataset_repo/gazebo/<name>）")
    args = ap.parse_args()

    out = Path(args.out) if args.out else None
    result = gazebo_export.export_gazebo(
        args.name,
        out_root=out,
        mesh_grid=args.mesh_grid,
        visual_mesh_grid=args.visual_mesh_grid,
        tex_size=args.tex_size,
    )
    print("[导出完成] %s" % result["name"])
    print("  输出目录 : %s" % result["out_dir"])
    print("  边长     : %.0f m   碰撞网格 %dx%d   视觉网格 %dx%d   最大高程 %.2f m"
          % (result["size_m"], result["mesh_grid"], result["mesh_grid"],
             result.get("visual_mesh_grid", 0), result.get("visual_mesh_grid", 0),
             result["max_height_m"]))
    sp = result["spawn"]
    print("  spawn 点 : (%.1f, %.1f)  地面 z=%.2f m  补丁最坏坡度 %.2f°%s"
          % (sp["world_x"], sp["world_y"], sp["ground_z"],
             sp["worst_case_slope_deg"],
             "" if sp["meets_5deg"] else "（未达 <5°，取最平坦处）"))
    print("  任务标记 : %d 个" % len(result["waypoints"]))
    print("  运行     : GZ_SIM_RESOURCE_PATH=%s/models gz sim -r %s"
          % (result["out_dir"], result["files"]["world"]))

    if args.zip:
        pkg = gazebo_export.package_export(
            args.name, out_root=Path(result["out_dir"]), fmt="zip")
        print("  压缩包   : %s" % pkg)


if __name__ == "__main__":
    main()
