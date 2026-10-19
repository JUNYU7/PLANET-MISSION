"""PlanetMission 统一启动入口。"""

import argparse
import subprocess
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BACKEND_DIR))

from app.settings import API_HOST, API_PORT, FRONTEND_DIST, REGIONS_INDEX  # noqa: E402

def report_artifacts() -> bool:
    if not REGIONS_INDEX.exists():
        print("[警告] 未找到 %s" % REGIONS_INDEX)
        print("       请先执行：python backend/start.py --process")
        return False
    print("区域索引：%s" % REGIONS_INDEX)
    return True

def run_process() -> int:
    cmd = [sys.executable, str(BACKEND_DIR / "tools" / "process_all.py")]
    print("执行数据处理：%s" % " ".join(cmd))
    return subprocess.call(cmd)

def main() -> int:
    parser = argparse.ArgumentParser(description="PlanetMission 服务")
    parser.add_argument("--process", action="store_true")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--host", default=API_HOST)
    parser.add_argument("--port", type=int, default=API_PORT)
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args()

    if args.check:
        tool = BACKEND_DIR / "tools" / "check_coords.py"
        return subprocess.call([sys.executable, str(tool)])

    if args.process:
        code = run_process()
        if code != 0:
            print("数据处理失败，退出。")
            return code

    print("")
    report_artifacts()

    if not FRONTEND_DIST.exists():
        print("[提示] 未找到前端产物 %s" % FRONTEND_DIST)
        print("       请先构建：cd frontend && npm install && npm run build")

    import uvicorn

    from app.main import app

    print("")
    print("服务已启动：http://%s:%d" % (args.host, args.port))
    print("")
    uvicorn.run(app, host=args.host, port=args.port, reload=args.reload)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())