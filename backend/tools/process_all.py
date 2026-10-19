"""批量处理全部已注册区域。

运行：python backend/tools/process_all.py
"""

import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

from app.pipeline.process_region import process_all

if __name__ == "__main__":
    raise SystemExit(process_all())