#!/usr/bin/env python3
"""
Procedural texture generator for the fishing game's texture library.

Generates every asset that has no good CC0 photographic source (or that is
simply better as a controllable procedural texture):

  - water_normal1.jpg / water_normal2.jpg  seamless tiling ocean normal maps
    (two scales: broad swell + fine ripple), built from summed directional
    Gerstner-like sine wave trains plus tileable Perlin fBm chop.
  - water_foam.png                          seamless foam/whitecap alpha mask
  - caustics.jpg                            seamless underwater caustic net
  - noise_rgb.png                           256x256 seamless RGB white noise
  - perlin.png                              256x256 seamless tiling grayscale
                                             Perlin fBm
  - sand_seafloor/normal.jpg                ripple-normal overlay baked onto
                                             the sourced underwater sand photo
  - fish_scales/{color,normal,rough}.jpg    fully procedural scale pattern
  - particles/*.png                         10 white/greyscale sprite sheets
                                             for the VFX system

Everything here tiles exactly (no visible seam) because every periodic
component (Perlin grid, sine wave trains, scale grid) is built so that the
image dimension is an exact integer multiple of the pattern's period, and all
gradients are computed with numpy's wraparound `np.roll` instead of
finite differences that fall off the edge.

Run directly:  python3 tools/gen_textures.py
Requires: numpy, Pillow (PIL)
"""
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

REPO = Path(__file__).resolve().parent.parent
TEX_DIR = REPO / "public/assets/textures"
PART_DIR = TEX_DIR / "particles"

rng_global = np.random.default_rng(20260901)


# --------------------------------------------------------------------------
# Core tileable noise primitives
# --------------------------------------------------------------------------

def tileable_perlin_layer(width, height, freq_x, freq_y, rng):
    """One octave of classic gradient (Perlin) noise on a freq_x*freq_y grid
    of random unit gradients, with wraparound padding so that the noise
    value at column `width` equals the value at column 0 (and same for rows)
    -> the layer tiles exactly across [0,width) x [0,height)."""
    angles = rng.uniform(0, 2 * np.pi, (freq_y, freq_x))
    gx = np.cos(angles)
    gy = np.sin(angles)
    # wrap-pad by 1 so cell (freq-1) can interpolate towards cell 0
    gx_p = np.pad(gx, ((0, 1), (0, 1)), mode="wrap")
    gy_p = np.pad(gy, ((0, 1), (0, 1)), mode="wrap")

    xs = np.linspace(0, freq_x, width, endpoint=False)
    ys = np.linspace(0, freq_y, height, endpoint=False)
    xx, yy = np.meshgrid(xs, ys)

    x0 = np.floor(xx).astype(int)
    y0 = np.floor(yy).astype(int)
    x1 = x0 + 1
    y1 = y0 + 1
    sx = xx - x0
    sy = yy - y0

    def dot(ix, iy):
        return gx_p[iy, ix] * (xx - ix) + gy_p[iy, ix] * (yy - iy)

    n00 = dot(x0, y0)
    n10 = dot(x1, y0)
    n01 = dot(x0, y1)
    n11 = dot(x1, y1)

    def fade(t):
        return t * t * t * (t * (t * 6 - 15) + 10)

    u = fade(sx)
    v = fade(sy)
    nx0 = n00 * (1 - u) + n10 * u
    nx1 = n01 * (1 - u) + n11 * u
    return nx0 * (1 - v) + nx1 * v


def tileable_fbm(width, height, base_freq, octaves=5, persistence=0.55, lacunarity=2, seed=0):
    """Fractal sum of tileable_perlin_layer octaves. base_freq must divide
    evenly however lacunarity scales it (use power-of-two lacunarity with a
    base_freq that is itself a divisor of width/height for guaranteed tiling)."""
    rng = np.random.default_rng(seed)
    total = np.zeros((height, width), dtype=np.float64)
    amp = 1.0
    max_amp = 0.0
    freq = base_freq
    for _ in range(octaves):
        fx = max(1, int(round(freq)))
        fy = max(1, int(round(freq * height / width)))
        total += amp * tileable_perlin_layer(width, height, fx, fy, rng)
        max_amp += amp
        amp *= persistence
        freq *= lacunarity
    return total / max_amp  # roughly in [-1, 1]


def normalize01(a):
    lo, hi = a.min(), a.max()
    if hi - lo < 1e-9:
        return np.zeros_like(a)
    return (a - lo) / (hi - lo)


def height_to_normal(height_field, strength=2.5):
    """Heightfield -> tangent-space GL normal map (RGB in [0,255] uint8),
    using wraparound central differences so edges stay seamless."""
    dzdx = (np.roll(height_field, -1, axis=1) - np.roll(height_field, 1, axis=1)) * strength
    dzdy = (np.roll(height_field, -1, axis=0) - np.roll(height_field, 1, axis=0)) * strength
    nx = -dzdx
    ny = -dzdy
    nz = np.ones_like(height_field)
    length = np.sqrt(nx * nx + ny * ny + nz * nz)
    nx, ny, nz = nx / length, ny / length, nz / length
    r = ((nx + 1) * 0.5 * 255).clip(0, 255).astype(np.uint8)
    g = ((ny + 1) * 0.5 * 255).clip(0, 255).astype(np.uint8)
    b = ((nz + 1) * 0.5 * 255).clip(0, 255).astype(np.uint8)
    return np.dstack([r, g, b])


# --------------------------------------------------------------------------
# Water normal maps (the hero asset)
# --------------------------------------------------------------------------

def gerstner_like_height(size, rng, n_waves, wavenumber_range, amp_power=1.3):
    """Sum of directional sine wave trains whose wave-vectors are integer
    multiples of 2*pi/size in each axis, so every wave is exactly periodic
    over the tile -> perfectly seamless. This approximates the look of
    Gerstner ocean waves (directional swell trains) as a height field."""
    xs = np.arange(size)
    xx, yy = np.meshgrid(xs, xs)
    height = np.zeros((size, size), dtype=np.float64)
    for i in range(n_waves):
        n = rng.integers(wavenumber_range[0], wavenumber_range[1] + 1)
        m = rng.integers(wavenumber_range[0], wavenumber_range[1] + 1)
        if n == 0 and m == 0:
            n = 1
        kx = 2 * np.pi * n / size
        ky = 2 * np.pi * m / size
        phase = rng.uniform(0, 2 * np.pi)
        k = math.hypot(n, m)
        amp = 1.0 / (k ** amp_power)  # longer waves (small k) dominate
        height += amp * np.sin(xx * kx + yy * ky + phase)
    return height


def make_water_normal(size, seed, swell_waves, swell_range, chop_freq, chop_octaves,
                       swell_weight, chop_weight, strength):
    rng = np.random.default_rng(seed)
    swell = gerstner_like_height(size, rng, swell_waves, swell_range)
    swell = swell / (np.abs(swell).max() + 1e-9)

    chop = tileable_fbm(size, size, chop_freq, octaves=chop_octaves, persistence=0.5, seed=seed + 1)
    chop = chop / (np.abs(chop).max() + 1e-9)

    height = swell_weight * swell + chop_weight * chop
    normal_rgb = height_to_normal(height, strength=strength)
    return Image.fromarray(normal_rgb, "RGB")


# --------------------------------------------------------------------------
# Foam
# --------------------------------------------------------------------------

def make_water_foam(size=512, seed=7):
    fbm1 = tileable_fbm(size, size, base_freq=4, octaves=5, persistence=0.55, seed=seed)
    fbm2 = tileable_fbm(size, size, base_freq=9, octaves=3, persistence=0.5, seed=seed + 50)
    combo = normalize01(fbm1 * 0.7 + fbm2 * 0.3)
    # Sharpen into blobby whitecap patches via threshold + soft edge
    edge = 0.52
    soft = 0.22
    alpha = np.clip((combo - edge) / soft, 0, 1)
    alpha = alpha ** 0.8
    # fine crackle detail multiplied in so foam edges look bubbly, not flat
    detail = normalize01(tileable_fbm(size, size, base_freq=24, octaves=3, persistence=0.5, seed=seed + 99))
    alpha = alpha * (0.65 + 0.35 * detail)
    alpha_u8 = (np.clip(alpha, 0, 1) * 255).astype(np.uint8)
    rgb = np.full((size, size, 3), 255, dtype=np.uint8)
    rgba = np.dstack([rgb, alpha_u8])
    return Image.fromarray(rgba, "RGBA")


# --------------------------------------------------------------------------
# Caustics
# --------------------------------------------------------------------------

def make_caustics(size=512, seed=13):
    def ridged(fbm):
        r = 1.0 - np.abs(fbm)
        return r

    fbm_a = tileable_fbm(size, size, base_freq=5, octaves=4, persistence=0.55, seed=seed)
    fbm_b = tileable_fbm(size, size, base_freq=6, octaves=4, persistence=0.55, seed=seed + 1)
    ra = ridged(normalize01(fbm_a) * 2 - 1)
    rb = ridged(normalize01(fbm_b) * 2 - 1)
    net = ra * rb
    net = normalize01(net) ** 3.0

    fine = normalize01(tileable_fbm(size, size, base_freq=13, octaves=3, persistence=0.5, seed=seed + 2))
    net = net * (0.75 + 0.25 * fine)
    net = normalize01(net)

    # subtle aqua tint: near-white core, faint cyan in the shadows
    g = (net * 255).clip(0, 255).astype(np.uint8)
    r = (net * 235).clip(0, 255).astype(np.uint8)
    b = (net * 255).clip(0, 255).astype(np.uint8)
    rgb = np.dstack([r, g, b])
    return Image.fromarray(rgb, "RGB")


# --------------------------------------------------------------------------
# noise_rgb / perlin single-channel utility textures
# --------------------------------------------------------------------------

def make_noise_rgb(size=256, seed=42):
    rng = np.random.default_rng(seed)
    arr = rng.integers(0, 256, (size, size, 3), dtype=np.uint8)
    return Image.fromarray(arr, "RGB")


def make_perlin_gray(size=256, seed=99):
    fbm = tileable_fbm(size, size, base_freq=8, octaves=4, persistence=0.5, seed=seed)
    g = (normalize01(fbm) * 255).astype(np.uint8)
    return Image.fromarray(g, "L").convert("RGB")


# --------------------------------------------------------------------------
# Sand-seafloor ripple normal (overlay baked onto the sourced photo normal)
# --------------------------------------------------------------------------

def make_sand_ripple_normal(size=1024, seed=21):
    rng = np.random.default_rng(seed)
    xs = np.arange(size)
    xx, yy = np.meshgrid(xs, xs)
    # dominant ripple direction (a handful of parallel bands), lightly warped
    warp = tileable_fbm(size, size, base_freq=6, octaves=3, persistence=0.5, seed=seed + 1)
    n = 14  # integer wavenumber across the tile -> seamless
    phase_warp = warp * 1.6
    ripple = np.sin(2 * np.pi * n * (yy / size) + phase_warp)
    # asymmetric ripple profile (steeper lee side) for a more natural sand-ripple look
    ripple = np.sign(ripple) * (np.abs(ripple) ** 0.7)
    fine = tileable_fbm(size, size, base_freq=20, octaves=3, persistence=0.5, seed=seed + 2)
    height = 0.8 * ripple + 0.25 * fine
    normal_rgb = height_to_normal(height, strength=1.4)
    return Image.fromarray(normal_rgb, "RGB")


# --------------------------------------------------------------------------
# Fish scales material (color + normal + rough), fully procedural
# --------------------------------------------------------------------------

def _scale_fields(size, rows, cols, rx=0.60, ry=1.18):
    """Rows of overlapping scallop domes (classic imbricated fish-scale /
    shingle layout): a staggered lattice of anchor points, one dome per
    anchor, anisotropic radius (rx,ry) chosen wide-and-short in pixel space.
    Domes from consecutive rows deliberately overlap (ry > 1 row-spacing);
    a simple painter's algorithm (higher row index = drawn later = in front)
    picks the winner per pixel, which is what produces the curved
    "free edge" look of each scale instead of a brick/tile grid.
    Periodic in both row and col counts -> tiles exactly with no seam."""
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float64)
    cell_h = size / rows
    cell_w = size / cols
    ny = yy / cell_h
    nx = xx / cell_w

    best_d = np.full((size, size), np.inf)
    best_row = np.zeros((size, size), dtype=np.int64)
    best_col = np.zeros((size, size), dtype=np.int64)

    # only rows {-1, 0, +1} relative to a pixel's own row can be within reach
    # since ry < 2 row-spacings; iterate in increasing row order so the last
    # write among "inside" candidates is always the frontmost (painter's algo).
    for dr in (-1, 0, 1):
        row = np.floor(ny).astype(np.int64) + dr
        stagger = 0.5 * ((row % 2 + 2) % 2)  # 0 or 0.5, safe for negative rows
        col = np.round(nx - stagger).astype(np.int64)
        anchor_x = col + stagger
        anchor_y = row.astype(np.float64)
        d = np.sqrt(((nx - anchor_x) / rx) ** 2 + ((ny - anchor_y) / ry) ** 2)
        inside = d < 1.0
        best_d = np.where(inside, d, best_d)
        best_row = np.where(inside, row, best_row)
        best_col = np.where(inside, col, best_col)

    scale_h = np.clip(1.0 - best_d, 0, 1) ** 0.85
    scale_id = best_row * cols + best_col
    return scale_h, scale_id, best_row


def make_fish_scales(size=512, seed=5, rows=16, cols=11):
    scale_h, scale_id, row = _scale_fields(size, rows, cols)

    # per-scale id hash -> stable pseudo-random brightness/tint jitter
    hashed = (np.sin(scale_id.astype(np.float64) * 12.9898) * 43758.5453) % 1.0
    jitter = (hashed - 0.5) * 0.18

    base = np.array([0.72, 0.78, 0.82])  # neutral cool silver-grey (tintable)
    shade = 0.55 + 0.45 * scale_h  # brighter near scale center, darker at seams
    color = base[None, None, :] * (shade[..., None] + jitter[..., None])
    color = np.clip(color, 0, 1)

    # subtle horizontal banding so alternating rows read distinctly (like real scale rows)
    band = 1.0 + 0.04 * np.sin(row * np.pi)
    color = np.clip(color * band[..., None], 0, 1)

    color_u8 = (color * 255).astype(np.uint8)
    color_img = Image.fromarray(color_u8, "RGB")

    normal_img = Image.fromarray(height_to_normal(scale_h, strength=3.2), "RGB")

    rough = np.clip(0.35 + 0.35 * (1.0 - scale_h) + jitter, 0.12, 0.9)
    rough_u8 = (rough * 255).astype(np.uint8)
    rough_img = Image.fromarray(rough_u8, "L").convert("RGB")

    return color_img, normal_img, rough_img


# --------------------------------------------------------------------------
# Particle sprites (white/greyscale RGBA, tintable)
# --------------------------------------------------------------------------

def _canvas(size):
    return Image.new("RGBA", (size, size), (0, 0, 0, 0))


def _radial_alpha(size, cx, cy, radius, power=1.0, inner=0.0):
    ys, xs = np.mgrid[0:size, 0:size].astype(np.float64)
    d = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2) / radius
    a = np.clip(1.0 - d, 0, 1)
    if inner > 0:
        a = np.clip((d - inner) / (1 - inner) * -1 + 1, 0, 1) * (d >= 0)
    a = a ** power
    return a


def gen_droplet(size=128):
    """Teardrop via a 2D round-cone SDF: a line segment from the tip point to
    the belly center, with radius lerping 0 -> r along it (and staying r
    beyond the belly, so the bottom is a full round cap). This is smooth by
    construction (Minkowski sum of a segment with a growing disk) -- unlike
    a cardioid, it has no dimple at the point."""
    s = size
    ys, xs = np.mgrid[0:s, 0:s].astype(np.float64)
    tip = (s * 0.5, s * 0.10)
    center = (s * 0.5, s * 0.64)
    r = s * 0.24
    abx, aby = center[0] - tip[0], center[1] - tip[1]
    ab_len2 = abx * abx + aby * aby
    px, py = xs - tip[0], ys - tip[1]
    t = np.clip((px * abx + py * aby) / ab_len2, 0, 1)
    closest_x = tip[0] + t * abx
    closest_y = tip[1] + t * aby
    dist = np.sqrt((xs - closest_x) ** 2 + (ys - closest_y) ** 2)
    sdf = dist - t * r  # negative = inside
    edge = s * 0.035
    alpha = np.clip(0.5 - sdf / edge, 0, 1)
    img = Image.fromarray((alpha * 255).astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(0.8))
    alpha_arr = np.array(img)
    # shading: bright highlight upper-left of the belly, darker rim for volume
    hl = _radial_alpha(s, center[0] - r * 0.35, center[1] - r * 0.25, r * 1.5, power=1.5)
    lum = (175 + hl * 80).clip(0, 255)
    rgb = np.dstack([lum, lum, np.clip(lum + 12, 0, 255)]).astype(np.uint8)
    rgba = np.dstack([rgb, alpha_arr])
    return Image.fromarray(rgba, "RGBA")


def gen_bubble(size=128):
    s = size
    cx, cy = s / 2, s / 2
    r = s * 0.38
    ys, xs = np.mgrid[0:s, 0:s].astype(np.float64)
    d = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2)
    ring = np.exp(-((d - r) ** 2) / (2 * (s * 0.045) ** 2))
    fill = np.clip(1 - d / r, 0, 1) ** 3 * 0.25
    alpha = np.clip(ring * 0.9 + fill, 0, 1)
    alpha = np.where(d <= r * 1.08, alpha, 0)
    # small specular highlight
    hx, hy = cx - r * 0.4, cy - r * 0.45
    hl = np.exp(-((xs - hx) ** 2 + (ys - hy) ** 2) / (2 * (s * 0.07) ** 2))
    alpha = np.clip(alpha + hl * 0.8, 0, 1)
    lum = np.full((s, s), 255.0)
    rgba = np.dstack([lum, lum, lum, alpha * 255]).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")


def gen_ring(size=128):
    s = size
    cx, cy = s / 2, s / 2
    r = s * 0.34
    ys, xs = np.mgrid[0:s, 0:s].astype(np.float64)
    d = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2)
    band = np.exp(-((d - r) ** 2) / (2 * (s * 0.06) ** 2))
    alpha = np.clip(band, 0, 1)
    lum = np.full((s, s), 255.0)
    rgba = np.dstack([lum, lum, lum, alpha * 255]).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")


def _rays(size, n_rays, core_r, ray_len, ray_width_deg, rng, twist=0.0):
    s = size
    cx, cy = s / 2, s / 2
    ys, xs = np.mgrid[0:s, 0:s].astype(np.float64)
    dx, dy = xs - cx, ys - cy
    d = np.sqrt(dx * dx + dy * dy)
    ang = np.arctan2(dy, dx)
    alpha = np.zeros((s, s))
    for i in range(n_rays):
        base_ang = twist + i * (2 * np.pi / n_rays) + rng.uniform(-0.05, 0.05)
        diff = np.angle(np.exp(1j * (ang - base_ang)))
        width = np.radians(ray_width_deg)
        ang_falloff = np.clip(1 - np.abs(diff) / width, 0, 1)
        len_falloff = np.clip(1 - d / ray_len, 0, 1) ** 1.6
        alpha = np.maximum(alpha, ang_falloff * len_falloff)
    core = np.clip(1 - d / core_r, 0, 1) ** 0.6
    alpha = np.clip(np.maximum(alpha, core), 0, 1)
    return alpha


def gen_spark(size=128, seed=3):
    rng = np.random.default_rng(seed)
    s = size
    alpha = _rays(s, n_rays=6, core_r=s * 0.07, ray_len=s * 0.46, ray_width_deg=6, rng=rng)
    img = Image.fromarray((alpha * 255).astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(0.8))
    a = np.array(img)
    lum = np.full((s, s), 255)
    rgba = np.dstack([lum, lum, lum, a]).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")


def gen_star(size=128, seed=11):
    rng = np.random.default_rng(seed)
    s = size
    alpha = _rays(s, n_rays=4, core_r=s * 0.10, ray_len=s * 0.5, ray_width_deg=3.2, rng=rng)
    img = Image.fromarray((alpha * 255).astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(0.6))
    a = np.array(img).astype(np.float64)
    # soft halo behind the pointed rays
    ys, xs = np.mgrid[0:s, 0:s].astype(np.float64)
    cx = cy = s / 2
    d = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2)
    halo = np.clip(1 - d / (s * 0.30), 0, 1) ** 1.8 * 120
    a = np.clip(a + halo, 0, 255)
    lum = np.full((s, s), 255)
    rgba = np.dstack([lum, lum, lum, a]).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")


def gen_flare(size=128):
    s = size
    cx = cy = s / 2
    ys, xs = np.mgrid[0:s, 0:s].astype(np.float64)
    d = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2)
    core = np.clip(1 - d / (s * 0.16), 0, 1) ** 1.2
    glow = np.clip(1 - d / (s * 0.48), 0, 1) ** 2.2 * 0.8
    ring = np.exp(-((d - s * 0.38) ** 2) / (2 * (s * 0.05) ** 2)) * 0.35
    alpha = np.clip(core + glow + ring, 0, 1)
    lum = np.full((s, s), 255)
    rgba = np.dstack([lum, lum, lum, alpha * 255]).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")


def _blob_cluster(size, seed, n_blobs, r_range, spread, power=1.0):
    rng = np.random.default_rng(seed)
    s = size
    cx = cy = s / 2
    ys, xs = np.mgrid[0:s, 0:s].astype(np.float64)
    alpha = np.zeros((s, s))
    for _ in range(n_blobs):
        ang = rng.uniform(0, 2 * np.pi)
        rad = rng.uniform(0, spread)
        bx = cx + math.cos(ang) * rad
        by = cy + math.sin(ang) * rad
        br = rng.uniform(*r_range)
        d = np.sqrt((xs - bx) ** 2 + (ys - by) ** 2) / br
        alpha = np.maximum(alpha, np.clip(1 - d, 0, 1))
    return np.clip(alpha, 0, 1) ** power


def gen_smoke(size=128, seed=17):
    s = size
    alpha = _blob_cluster(s, seed, n_blobs=9, r_range=(s * 0.18, s * 0.30), spread=s * 0.16, power=1.0)
    img = Image.fromarray((alpha * 255).astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(s * 0.035))
    a = np.array(img).astype(np.float64)
    # break up the silhouette with soft fbm so it doesn't read as perfectly round
    detail = normalize01(tileable_fbm(s, s, base_freq=5, octaves=4, persistence=0.55, seed=seed + 3))
    a = a * (0.55 + 0.45 * detail)
    lum = np.full((s, s), 235.0)
    rgba = np.dstack([lum, lum, lum, np.clip(a, 0, 255)]).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")


def gen_foam_puff(size=128, seed=23):
    s = size
    alpha = _blob_cluster(s, seed, n_blobs=14, r_range=(s * 0.12, s * 0.22), spread=s * 0.22, power=0.9)
    img = Image.fromarray((alpha * 255).astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(s * 0.012))
    a = np.array(img).astype(np.float64)
    detail = normalize01(tileable_fbm(s, s, base_freq=8, octaves=3, persistence=0.5, seed=seed + 3))
    a = np.clip(a * (0.7 + 0.3 * detail), 0, 255)
    lum = np.full((s, s), 255.0)
    rgba = np.dstack([lum, lum, lum, a]).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")


def gen_splash(size=128, seed=31):
    """Impact burst: thorn-shaped spikes that are wide at the base and taper
    to an actual point (angular half-width shrinks with radius, not just the
    alpha), plus a tiny droplet accent right at each tip."""
    rng = np.random.default_rng(seed)
    s = size
    cx = cy = s / 2
    ys, xs = np.mgrid[0:s, 0:s].astype(np.float64)
    dx, dy = xs - cx, ys - cy
    d = np.sqrt(dx * dx + dy * dy)
    ang = np.arctan2(dy, dx)
    alpha = np.zeros((s, s))
    n_droplets = 9
    for i in range(n_droplets):
        base_ang = i * (2 * np.pi / n_droplets) + rng.uniform(-0.15, 0.15)
        length = rng.uniform(s * 0.34, s * 0.48)
        base_width_deg = rng.uniform(9, 14)
        diff = np.angle(np.exp(1j * (ang - base_ang)))
        t = np.clip(d / length, 0, 1)
        width_deg = base_width_deg * (1 - t) ** 1.6  # taper to an actual point
        width = np.radians(np.maximum(width_deg, 0.5))
        ang_falloff = np.clip(1 - np.abs(diff) / width, 0, 1)
        len_falloff = np.clip(1 - t, 0, 1) ** 0.6
        spike = ang_falloff * len_falloff
        tipx, tipy = cx + math.cos(base_ang) * length * 0.94, cy + math.sin(base_ang) * length * 0.94
        tip = np.clip(1 - np.sqrt((xs - tipx) ** 2 + (ys - tipy) ** 2) / (s * 0.028), 0, 1)
        alpha = np.maximum(alpha, np.maximum(spike, tip * 0.9))
    core = np.clip(1 - d / (s * 0.10), 0, 1) ** 0.7
    alpha = np.clip(np.maximum(alpha, core), 0, 1)
    img = Image.fromarray((alpha * 255).astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(0.6))
    a = np.array(img)
    lum = np.full((s, s), 255)
    rgba = np.dstack([lum, lum, lum, a]).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")


def gen_dust(size=128, seed=41):
    s = size
    alpha = _blob_cluster(s, seed, n_blobs=6, r_range=(s * 0.09, s * 0.15), spread=s * 0.12, power=1.1)
    img = Image.fromarray((alpha * 255).astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(s * 0.035))
    a = np.array(img).astype(np.float64) * 0.75  # faint but still legible
    lum = np.full((s, s), 220.0)
    rgba = np.dstack([lum, lum, lum, np.clip(a, 0, 255)]).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def save(img, path, **kw):
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, **kw)
    print(f"  wrote {path.relative_to(REPO)}  ({path.stat().st_size / 1024:.1f} KB)")


def main():
    print("== water normal maps ==")
    n1 = make_water_normal(1024, seed=100, swell_waves=6, swell_range=(1, 4),
                            chop_freq=10, chop_octaves=5, swell_weight=0.75, chop_weight=0.35,
                            strength=2.2)
    save(n1, TEX_DIR / "water_normal1.jpg", format="JPEG", quality=90, optimize=True)

    n2 = make_water_normal(1024, seed=200, swell_waves=10, swell_range=(3, 9),
                            chop_freq=22, chop_octaves=5, swell_weight=0.5, chop_weight=0.55,
                            strength=2.8)
    save(n2, TEX_DIR / "water_normal2.jpg", format="JPEG", quality=90, optimize=True)

    print("== water foam ==")
    save(make_water_foam(512), TEX_DIR / "water_foam.png", format="PNG", optimize=True)

    print("== caustics ==")
    save(make_caustics(512), TEX_DIR / "caustics.jpg", format="JPEG", quality=85, optimize=True)

    print("== noise_rgb / perlin ==")
    save(make_noise_rgb(256), TEX_DIR / "noise_rgb.png", format="PNG", optimize=True)
    save(make_perlin_gray(256), TEX_DIR / "perlin.png", format="PNG", optimize=True)

    print("== sand_seafloor ripple normal ==")
    save(make_sand_ripple_normal(1024), TEX_DIR / "sand_seafloor" / "normal.jpg",
         format="JPEG", quality=90, optimize=True)

    print("== fish_scales material ==")
    color, normal, rough = make_fish_scales(512)
    save(color, TEX_DIR / "fish_scales" / "color.jpg", format="JPEG", quality=82, optimize=True)
    save(normal, TEX_DIR / "fish_scales" / "normal.jpg", format="JPEG", quality=90, optimize=True)
    save(rough, TEX_DIR / "fish_scales" / "rough.jpg", format="JPEG", quality=82, optimize=True)

    print("== particle sprites ==")
    particles = {
        "smoke": gen_smoke(128),
        "splash": gen_splash(128),
        "droplet": gen_droplet(128),
        "bubble": gen_bubble(128),
        "spark": gen_spark(128),
        "star": gen_star(128),
        "ring": gen_ring(128),
        "flare": gen_flare(128),
        "foam_puff": gen_foam_puff(128),
        "dust": gen_dust(128),
    }
    for name, img in particles.items():
        save(img, PART_DIR / f"{name}.png", format="PNG", optimize=True)

    print("\nAll procedural textures generated.")


if __name__ == "__main__":
    main()
