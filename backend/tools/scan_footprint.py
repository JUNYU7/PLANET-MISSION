"""为区域挑选裁剪中心：优先避开 DTM 空洞，再核验正射影像零值率。

为什么扫 DTM 而不是 ortho（性能与准确性）：
原实现按 2000 m 分块扫描正射影像。但正射为 JPEG2000 单码流压缩，
没有 GeoTIFF 那种 tile 级随机访问，读任意窗口都要从最近的码流位置
顺序解码；2000 m ÷ 0.25 m = 8000×8000 px 一块，6×3 块已覆盖全图 82%，
实际接近「反复解码整幅 1.4 GB 影像」，耗时不可接受。

DTM 为 ISIS/PDS 裸二进制（无压缩），读整幅仅数百 MB、秒级完成。更重要
的是真正致命的是 DTM 的 nodata——它只能靠 fill_invalid 用邻域插值填充，
比例高会引入明显伪影；而正射零值在 pipeline 里会被 percentile_stretch
压到暗部，属可接受降级。

算法：对 nodata 掩膜做二维积分图，一次性求出所有合法位置的 k×k 窗口
缺失像素数，取全局最小者，因此结果是**像素级最优**而非块级近似。

投影参数从 DTM 栅格自身的 CRS 实测读取：HiRISE 单景使用中央经线非 0
的局部等距圆柱（lon_0=157.34、lat_ts=5、R=3396036.81），按
R=MARS_RADIUS_M 与 lon_0=0 反算会把中心定位到数千公里外。

运行：python backend/tools/scan_footprint.py [区域名] [边长米]
      不给区域名时取第一个已注册区域；不给边长时取 2000 m。
"""

import io
import sys
import warnings
from math import hypot, radians
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.windows import Window
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

from app.core import coords  # noqa: E402
from app.settings import DTM_FILE, ORTHO_FILE, REGIONS  # noqa: E402


def find_region(name):
    """按名称取区域配置；None 时取第一个已注册区域。"""
    if name is None:
        return REGIONS[0]
    for r in REGIONS:
        if str(r["name"]) == name:
            return r
    raise SystemExit(
        "未知区域 %r。已注册：%s"
        % (name, ", ".join(str(r["name"]) for r in REGIONS))
    )


def _window_relief(band, miss, k, blk):
    """求所有 k×k 窗口的高程极差（max−min），返回 (relief, blk)。

    高斯/最大值滤波无法对 NaN 正确工作，且 k 可达近两千像素，逐窗口精确
    计算代价过高。改为两级：先把DTM 按 blk×blk 分块求块内min/max
    （块级矩阵仅约 50×100），再对块级矩阵做滑动极值。

    窗口的真实 max 等于「窗口内所有块 max 的最大」，真实 min 等于
    「窗口内所有块 min 的最小」，因此两级合成给出的是**精确窗口极差**，
    而非近似。返回矩阵的元素对应像素窗口左上角 (i·blk, j·blk)。
    """
    h, w = band.shape
    nh = (h // blk) * blk
    nw = (w // blk) * blk
    filled = np.where(miss[:nh, :nw], np.nan, band[:nh, :nw])
    sub = filled.reshape(nh // blk, blk, nw // blk, blk)
    with warnings.catch_warnings():
        # 整块皆为 nodata 时 nanmin/nanmax 会产生 RuntimeWarning，
        # 该块的极值不可信，但缺块必然同时落入高缺失率窗口而被后续筛选排除。
        warnings.simplefilter("ignore", category=RuntimeWarning)
        blk_min = np.nanmin(sub, axis=(1, 3))
        blk_max = np.nanmax(sub, axis=(1, 3))
    del sub, filled

    kb = int(round(k / float(blk)))
    if kb < 1:
        raise SystemExit("目标窗口 %d px 小于块尺寸 %d px" % (k, blk))
    relief = (ndimage.maximum_filter(blk_max, size=kb, mode="constant",
                                     cval=-np.inf)
              - ndimage.minimum_filter(blk_min, size=kb, mode="constant",
                                      cval=np.inf))
    return relief, blk


def scan_centers(dtm_path, size_m, max_miss_ratio=0.01):
    """在 DTM 上挑裁剪中心。

    两级筛选：先要求缺失率≤ max_miss_ratio（DTM 缺失只能靠邻域插值
    填充，比例高会引入伪影），再在其中选地形起伏最大的窗口——火星车
    场景需要坡度层次，起伏过小的窗口会让坡度/曲率/TI 图层全部趋于同色。

    若全图无满足缺失阈值的窗口，则退化为选缺失率最小者并如实报告。
    """
    with rasterio.open(dtm_path) as d:
        proj = coords.projection_from_crs(d.crs)
        transform = d.transform
        mpp = abs(transform.a)
        nodata = d.nodata
        h, w = d.height, d.width
        print("DTM   %s" % dtm_path.name)
        print("投影  R=%.1f  lon_0=%.4f  lat_ts=%.4f"
              % (proj.radius, proj.lon_0, proj.lat_ts))
        print("影像  %d x %d  %.4f m/px" % (w, h, mpp))
        k = int(round(size_m / mpp))
        if k > h or k > w:
            raise SystemExit("目标 %.0f m（%d px）超过 DTM 尺寸 %dx%d"
                             % (size_m, k, w, h))
        print("目标窗口 %d px (%.0f m)，读取全图…" % (k, k * mpp), flush=True)
        band = d.read(1)

    miss = (band == nodata) if nodata is not None else ~np.isfinite(band)
    band = np.where(miss, np.nan, band)
    print("全图缺失 %.3f%%" % (100.0 * float(miss.mean())))

    # 二维积分图：s[i, j] = 以 (i, j) 为左上角的 k×k 窗口缺失像素数。
    # s 的形状恰为 (h-k+1, w-k+1)，即全部不越界窗口，无需再过滤。
    m32 = miss.astype(np.int32)
    ii = np.zeros((h + 1, w + 1), dtype=np.int32)
    ii[1:, 1:] = m32.cumsum(axis=0, dtype=np.int32).cumsum(
        axis=1, dtype=np.int32)
    del m32
    ratio = (ii[k:, k:] - ii[:-k, k:] - ii[k:, :-k] + ii[:-k, :-k])
    ratio = ratio.astype(np.float64) / (float(k) * float(k))
    del ii

    blk = 128 if min(h, w) // 128 >= 16 else 32
    relief, blk = _window_relief(band, miss, k, blk)
    print("极值分块 %d px (%.0f m)，候选分辨率 %.0f m"
          % (blk, blk * mpp, blk * mpp))
    del band, miss

    # 对齐块级 relief 与像素级 ratio：取两者公共形状的子集
    rows = min(relief.shape[0], ratio.shape[0] // blk)
    cols = min(relief.shape[1], ratio.shape[1] // blk)
    r_sub = ratio[::blk, ::blk][:rows, :cols]
    rel_sub = relief[:rows, :cols]

    ok = r_sub <= max_miss_ratio
    n_ok = int(ok.sum())
    print("缺失率 ≤ %.2f%% 的窗口 %d / %d"
          % (100.0 * max_miss_ratio, n_ok, r_sub.size))
    if n_ok:
        # 主排序为起伏（越大地形层次越足），但「完全无缺失」的窗口优先——
        # fill_invalid 的邻域插值会在缺失处留下可见的平滑痕迹，
        # 即使缺失率只有 0.2% 也应尽量避开。加一个远大于起伏量级的
        # 偏移实现分档：干净窗口整体排在有缺失窗口之前。
        clean = r_sub <= 1e-4
        score = np.where(ok, rel_sub, -np.inf)
        score = np.where(clean & ok, score + 1.0e3, score)
    else:
        print("无窗口满足缺失阈值，退化为取缺失率最低者")
        score = -r_sub

    # ---- 阶段一：块级粗筛 ----
    # 块级极值以 kb·blk 像素近似 k 像素（1978 vs 1920），边缘约 58 m
    # 未计入，断层崖处可低估数十米。因此只用来挑候选，不用于结论。
    topn = 30
    order = np.argsort(score.ravel())[::-1][:topn]
    approx = []
    for flat in order.tolist():
        cy, cx = np.unravel_index(flat, r_sub.shape)
        approx.append((cy * blk, cx * blk))

    # ---- 阶段二：精确复核 ----
    print("精确复核 %d 个候选（逐个读 k×k 窗口）…" % len(approx), flush=True)
    refined = []
    with rasterio.open(dtm_path) as d:
        for row0, col0 in approx:
            if row0 + k > h or col0 + k > w:
                continue
            a = d.read(1, window=Window(col0, row0, k, k))
            m = (a == nodata) if nodata is not None else ~np.isfinite(a)
            v = a[~m]
            if v.size == 0:
                continue
            refined.append((float(v.max() - v.min()), float(m.mean()),
                            col0, row0))
    # 排序：先「完全无缺失」分档（与阶段一同），档内按起伏降序。
    # 缺失优先于起伏：0.2% 的缺失率意味着上千个像素要靠邻域插值填补，
    # 其伪影对火星车仿真的影响大于几米的起伏差异。
    refined.sort(key=lambda t: (0 if t[1] <= 1e-4 else 1, -t[0]))
    print("")
    print("精确结果（前 12）:")
    print("   %9s %8s %11s %10s" % ("lon", "lat", "缺失%", "起伏m"))
    cands = []
    for relief, miss, col0, row0 in refined[:12]:
        lon, lat = _pixel_to_lonlat(transform, proj,
                                     col0 + k / 2.0, row0 + k / 2.0)
        cands.append((relief, miss, lon, lat))
        print("  %9.4f %8.4f %10.4f%% %10.2f"
              % (lon, lat, 100.0 * miss, relief))
    if not cands:
        raise SystemExit("所有候选窗口均无有效数据。")
    return cands[0]


def _pixel_to_lonlat(transform, proj, col, row):
    """连续像素坐标 → 经纬度。"""
    px = transform.c + col * transform.a
    py = transform.f + row * transform.e
    return coords.proj_to_lonlat(px, py, proj)


def check_ortho(ortho_path, lon, lat, size_m, probe=600):
    """在候选中心核验正射影像零值率。

    用 probe×probe 的降采样最近邻读取代替全分辨率：空洞是大尺度特征，
    不需要全分辨率细节；这是避免 JPEG2000 全码流解码的关键。
    """
    if not Path(ortho_path).exists():
        print("ortho %s 不存在，跳过核验" % Path(ortho_path).name)
        return None
    with rasterio.open(ortho_path) as d:
        proj = coords.projection_from_crs(d.crs)
        mpp = abs(d.transform.a)
        k = int(round(size_m / mpp))
        x, y = coords.lonlat_to_proj(lon, lat, proj)
        row, col = coords.proj_to_rowcol(d.transform, x, y)
        win = Window(col - k // 2, row - k // 2, k, k)
        out_h, out_w = min(probe, k), min(probe, k)
        print("")
        print("核验 ortho %s" % Path(ortho_path).name)
        print("  窗口 %d px (%.0f m)，降采样 %dx%d 读取中…"
              % (k, k * mpp, out_w, out_h), flush=True)
        data = d.read(1, window=win, out_shape=(out_h, out_w),
                      resampling=Resampling.nearest)
    zero = float((data == 0).mean())
    print("  零值率 %.4f%%   值域 %d~%d"
          % (100.0 * zero, int(data.min()), int(data.max())))
    return zero


def main():
    args = sys.argv[1:]
    region_name = None
    size_m = 2000.0
    max_miss = 0.01
    for a in args:
        try:
            size_m = float(a)
            continue
        except ValueError:
            pass
        if a.endswith("%"):
            max_miss = float(a[:-1]) / 100.0
        else:
            region_name = a

    region = find_region(region_name)
    print("区域  %s" % region["name"])
    relief, miss, lon, lat = scan_centers(
        region.get("dtm_file") or DTM_FILE, size_m, max_miss)

    anchor = region["landing_site"]
    with rasterio.open(region.get("dtm_file") or DTM_FILE) as d:
        proj = coords.projection_from_crs(d.crs)
    dlon = radians(lon - float(anchor["lon"])) * proj.radius
    dlat = radians(lat - float(anchor["lat"])) * proj.radius
    print("")
    print("推荐中心：lon=%.4f  lat=%.4f" % (lon, lat))
    print("  投影坐标  x=%.0f  y=%.0f"
          % coords.lonlat_to_proj(lon, lat, proj))
    print("  DTM 缺失  %.3f%%" % (100.0 * miss))
    print("  地形起伏  %.2f m" % relief)
    print("  距锚点    %.0f m" % hypot(dlon, dlat))
    print("")
    print("写入 settings.py 的该区域 center：")
    print('    "center": {"lon": %.4f, "lat": %.4f},' % (lon, lat))

    check_ortho(region.get("ortho_file") or ORTHO_FILE, lon, lat, size_m)


if __name__ == "__main__":
    main()