"""地形几何指标：坡度、曲率、粗糙度、地形晕渲。

依据 V4 策划书第 16 章实现。所有指标均基于已平滑的相对高程场，
单位统一为米与度，输出数组与输入同形。
"""

import numpy as np
from scipy import ndimage

__all__ = ["slope_deg", "curvature", "roughness", "hillshade", "normal_to_slope"]


def slope_deg(height, pixel_size_m: float = 1.0):
    """坡度（度）。

    对高程场做 Sobel 梯度算子，按像元物理尺寸换算后取反正切。
    调用前必须已平滑：1 m/px DTM 的垂直噪声达数十厘米，
    未平滑时梯度结果会被噪声主导，得到满屏噪点（V4 16.3）。
    """
    dz_dy, dz_dx = np.gradient(height, pixel_size_m)
    grad = np.hypot(dz_dx, dz_dy)
    return np.degrees(np.arctan(grad))


def curvature(height, pixel_size_m: float = 1.0):
    """曲率（1/m），二阶差分近似。

    正值表示凸起（岩石、脊线），负值表示凹坑。
    使用拉普拉斯算子，等价于 d2z/dx2 + d2z/dy2。
    """
    cell = float(pixel_size_m)
    laplacian = ndimage.laplace(height) / (cell * cell)
    return laplacian


def roughness(height, window: int = 3):
    """粗糙度（米），3×3 邻域内高程与局部均值的平均绝对偏差。

    R = mean(|z_i − mean(z_3x3)|)

    反映碎石地面的颠簸程度，关联振动与打滑风险。
    """
    if window % 2 == 0:
        raise ValueError("邻域窗口必须为奇数，实际 %d" % window)
    local_mean = ndimage.uniform_filter(height, size=window, mode="nearest")
    return np.abs(height - local_mean)


def normal_to_slope(height, pixel_size_m: float = 1.0):
    """由高程场求单位法向量，返回 (nx, ny, nz) 三元组。

    栅格 row0 在北，故北向梯度取负号，使法向量与 three.js 的
    +X 东 / +Y 上 / +Z 南 右手系一致。
    """
    dz_dy, dz_dx = np.gradient(height, pixel_size_m)
    nx = -dz_dx
    ny = dz_dy
    nz = np.ones_like(height)
    norm = np.sqrt(nx * nx + ny * ny + nz * nz)
    return nx / norm, ny / norm, nz / norm


def hillshade(height, pixel_size_m: float = 1.0,
              azimuth_deg: float = 315.0, altitude_deg: float = 45.0):
    """地形晕渲（0–255 uint8），朗伯反射模型。

    与 gdaldem hillshade 的约定一致：方位角自正北顺时针计量，
    光源高度角自水平面起算。用于在无纹理区域提供地形起伏的视觉参照。
    """
    slope_rad = np.radians(slope_deg(height, pixel_size_m))
    dz_dy, dz_dx = np.gradient(height, pixel_size_m)
    aspect = np.arctan2(dz_dx, -dz_dy)
    az = np.radians(360.0 - azimuth_deg)
    alt = np.radians(altitude_deg)

    shaded = (np.sin(alt) * np.cos(slope_rad)
              + np.cos(alt) * np.sin(slope_rad) * np.cos(az - aspect))
    shaded = np.clip(shaded, 0.0, 1.0)
    return (shaded * 255.0).astype(np.uint8)

