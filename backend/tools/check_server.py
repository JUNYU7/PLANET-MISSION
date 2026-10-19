"""端到端链路自检：验证前端页面、静态资源与接口均由同一服务提供。

运行：python backend/tools/check_server.py
"""

import io
import json
import re
import sys
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8",
                              errors="replace")

BASE = "http://127.0.0.1:8000"
FAILURES = []


def check(label, ok, detail=""):
    print("[%s] %s%s" % ("PASS" if ok else "FAIL", label,
                         ("  " + detail) if detail else ""))
    if not ok:
        FAILURES.append(label)


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return r.status, r.read(), r.headers.get("content-type", "")


def main():
    status, body, _ = get("/")
    html = body.decode("utf-8")
    check("首页可访问", status == 200, "HTTP %d" % status)
    check("页面包含 root 容器", '<div id="root">' in html)
    check("页面引用构建产物", "/assets/" in html)

    scripts = re.findall(r'src="([^"]+\.js)"', html)
    styles = re.findall(r'href="([^"]+\.css)"', html)
    check("找到入口脚本", len(scripts) == 1, str(scripts))
    check("找到样式表", len(styles) == 1, str(styles))

    for asset in scripts + styles:
        s, b, ct = get(asset)
        check("静态资源 %s" % asset.split("/")[-1], s == 200,
              "%d B  %s" % (len(b), ct))

    s, b, _ = get("/api/health")
    check("健康检查", json.loads(b)["status"] == "ok")

    s, b, _ = get("/api/regions")
    regions = json.loads(b)["regions"]
    check("区域列表非空", len(regions) > 0, "%d 个区域" % len(regions))
    name = regions[0]["name"]

    s, b, _ = get("/api/regions/%s" % name)
    detail = json.loads(b)
    manifest = detail["manifest"]["interactive"]
    check("区域详情含两套高程",
          len(detail["meta"]["elevation_absolute_range"]) == 2
          and len(detail["meta"]["height_range"]) == 2,
          "绝对 %s / 相对 %s"
          % (detail["meta"]["elevation_absolute_range"],
             detail["meta"]["height_range"]))
    check("清单给出交互与出图两档",
          detail["manifest"]["interactive"]["grid"] == 513
          and detail["manifest"]["capture"]["grid"] == 1025)
    check("图层清单完整", len(manifest["layers"]) == 7,
          ", ".join(str(l["id"]) for l in manifest["layers"]))

    s, b, ct = get("/api/regions/%s/assets/%s"
                   % (name, manifest["height_file"]))
    expect = manifest["grid"] ** 2 * 4
    check("高程二进制长度正确", len(b) == expect,
          "%d B，期望 %d B" % (len(b), expect))

    for layer in manifest["layers"]:
        if not layer["file"]:
            continue
        s, b, ct = get("/api/regions/%s/assets/%s" % (name, layer["file"]))
        check("图层 %s" % layer["file"], s == 200 and ct == "image/png",
              "%d B" % len(b))

    s, b, ct = get("/api/globe/texture")
    check("球体贴图", s == 200 and ct == "image/png", "%d B" % len(b))

    s, b, _ = get("/api/globe/project?lon=77.4298&lat=18.4663")
    pt = json.loads(b)
    check("球面坐标投影", abs(pt["x"]) + abs(pt["y"]) + abs(pt["z"]) > 0,
          "x=%.3f y=%.3f z=%.3f" % (pt["x"], pt["y"], pt["z"]))

    print()
    if FAILURES:
        print("自检失败 %d 项：" % len(FAILURES))
        for item in FAILURES:
            print("  - %s" % item)
        return 1
    print("端到端链路全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())