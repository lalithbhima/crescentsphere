#!/usr/bin/env python3
"""Cut real LOLA elevation windows out of NASA's big global/polar grids, anywhere on the Moon, using HTTP range requests
(only the rows that are needed are downloaded, a few tens of MB instead of gigabytes).

Sources (NASA PDS Geosciences / MIT Imbrium LOLA gridded data records):
  |lat| >= 75  : polar stereographic LDEM_75S/75N, 30 m per pixel
  60..75       : polar stereographic LDEM_60S/60N, 60 m
  45..60       : polar stereographic LDEM_45S/45N, 100 m
  |lat| < 45   : cylindrical LDEM_512, 512 pixels per degree (59 m at the equator)
  regional (100+ km wide) windows use LDEM_64 (473 m) or the 240 m polar grids.

Windows come out as heights in km above the 1737.4 km sphere on an east/north grid centred on the site, the same convention as the
app's flat site DEMs:  x = east km, y = north km;  lat = lat0 + y / R,  lon = lon0 + x / (R cos lat0).
"""
import concurrent.futures as cf, math, os, re, sys, time, urllib.request
import numpy as np
from scipy.ndimage import map_coordinates

RM = 1737.4
PDS = 'https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/'
IMB = 'https://imbrium.mit.edu/DATA/LOLA_GDR/POLAR/FLOAT_IMG/'
UA = {'User-Agent': 'lunar-navigator-dem/1.0 (research use)'}


def rget(url, a, b, tries=5):
    """bytes a..b-1 of url."""
    err = None
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={**UA, 'Range': f'bytes={a}-{b - 1}'})
            with urllib.request.urlopen(req, timeout=240) as r:
                data = r.read()
            if len(data) == b - a: return data
            err = RuntimeError(f'short read {len(data)} of {b - a}')
        except Exception as e:
            err = e
        time.sleep(2 * (k + 1))
    raise err


def read_rows(url, row_bytes, r0, r1, parts=6):
    """Rows r0..r1-1 of a raw row-major file as one bytes object (downloaded in parallel pieces)."""
    n = r1 - r0; per = max(1, math.ceil(n / parts)); spans = [(r0 + i, min(r1, r0 + i + per)) for i in range(0, n, per)]
    with cf.ThreadPoolExecutor(4) as ex:
        return b''.join(ex.map(lambda s: rget(url, s[0] * row_bytes, s[1] * row_bytes), spans))


# ------------------------------------------------------------------ cylindrical grids (LDEM_64 .. LDEM_512)
BANDS = ['45n_90n', '00n_45n', '45s_00s', '90s_45s']; BLOCKS = ['000_090', '090_180', '180_270', '270_360']


def cyl_sample(P, lats, lons):
    """Heights (km) at lat/lon arrays from the cylindrical LDEM at P pixels per degree (bilinear)."""
    lats = np.clip(lats, -89.999, 89.999); H = 180 * P; W = 360 * P
    fr = (90 - lats) * P - 0.5
    lon0 = float(np.mean(lons)); lonu = lon0 + ((lons - lon0 + 180) % 360 - 180)      # unwrapped around the site
    fc = lonu * P - 0.5
    r0, r1 = int(max(0, math.floor(fr.min()) - 1)), int(min(H, math.ceil(fr.max()) + 2)); c0, c1 = int(math.floor(fc.min()) - 1), int(math.ceil(fc.max()) + 2)
    M = np.zeros((r1 - r0, c1 - c0), np.float32)
    if P in (64, 128):
        name = 'ldem_64.img' if P == 64 else 'ldem_128.img'
        rows = np.frombuffer(read_rows(PDS + name, W * 2, r0, r1), '<i2').reshape(r1 - r0, W)
        M[:] = rows.take(np.arange(c0, c1) % W, axis=1) * 0.0005
    else:                                                   # 512 ppd: four latitude bands x four longitude blocks of 90 degrees
        bh, bw = 45 * P, 90 * P
        for b in range(4):
            ra, rb = max(r0, b * bh), min(r1, (b + 1) * bh)
            if ra >= rb: continue
            cache = {}
            c = c0
            while c < c1:
                cm = c % W; k = cm // bw; seg_end = min(c1, c + (bw - cm % bw))
                if k not in cache:
                    url = PDS + f'ldem_{P}_{BANDS[b]}_{BLOCKS[k]}.img'
                    cache[k] = np.frombuffer(read_rows(url, bw * 2, ra - b * bh, rb - b * bh), '<i2').reshape(rb - ra, bw)
                M[ra - r0:rb - r0, c - c0:seg_end - c0] = cache[k][:, (cm % bw):(cm % bw) + (seg_end - c)] * 0.0005
                c = seg_end
    return map_coordinates(M, [fr - r0, fc - c0], order=1, mode='nearest')


# ------------------------------------------------------------------ polar stereographic grids
POLAR = {  # (hemisphere, minimum |lat|, metres per pixel) -> file
    ('S', 75, 30): 'LDEM_75S_30M_FLOAT', ('S', 60, 60): 'LDEM_60S_60M_FLOAT', ('S', 45, 100): 'LDEM_45S_100M_FLOAT', ('S', 75, 240): 'LDEM_75S_240M_FLOAT',
    ('N', 75, 30): 'LDEM_75N_30M_FLOAT', ('N', 60, 60): 'LDEM_60N_60M_FLOAT', ('N', 45, 100): 'LDEM_45N_100M_FLOAT', ('N', 75, 240): 'LDEM_75N_240M_FLOAT',
}
_label = {}; _orient = {}


def polar_label(name):
    if name not in _label:
        txt = urllib.request.urlopen(urllib.request.Request(IMB + name + '.LBL', headers=UA), timeout=60).read().decode('latin1')
        g = lambda k: float(re.search(k + r'\s*=\s*([-\d.]+)', txt).group(1))
        _label[name] = {'n': int(g('LINES')), 'cy': g('LINE_PROJECTION_OFFSET'), 'cx': g('SAMPLE_PROJECTION_OFFSET'), 'm': g('MAP_SCALE') / 1000.0}   # km per pixel
    return _label[name]


def polar_xy(hem, lats, lons, lam_sign, swap):
    colat = np.radians(90 - np.abs(lats)); rho = 2 * RM * np.tan(colat / 2); lam = np.radians(lons) * lam_sign
    x, y = rho * np.sin(lam), rho * np.cos(lam)
    return (y, x) if swap else (x, y)


def polar_sample(hem, name, lats, lons, orient):
    lab = polar_label(name); n = lab['n']; lam_sign, a, b, swap = orient
    x, y = polar_xy(hem, lats, lons, lam_sign, swap)
    col = lab['cx'] + a * x / lab['m']; row = lab['cy'] + b * y / lab['m']
    r0, r1 = int(max(0, math.floor(row.min()) - 1)), int(min(n, math.ceil(row.max()) + 2)); c0, c1 = int(max(0, math.floor(col.min()) - 1)), int(min(n, math.ceil(col.max()) + 2))
    raw = np.frombuffer(read_rows(IMB + name + '.IMG', n * 4, r0, r1), '<f4').reshape(r1 - r0, n)
    return map_coordinates(raw[:, c0:c1], [row - r0, col - c0], order=1, mode='nearest')


def find_orient(hem):
    """Work out how the image axes map to polar x/y by matching the 240 m polar grid against the global LDEM_64 on test points."""
    if hem in _orient: return _orient[hem]
    name = POLAR[(hem, 75, 240)]; lab = polar_label(name); n = lab['n']
    full = np.frombuffer(read_rows(IMB + name + '.IMG', n * 4, 0, n, parts=8), '<f4').reshape(n, n)
    rng = np.random.default_rng(3); sgn = -1 if hem == 'S' else 1
    lats = sgn * rng.uniform(77, 89, 60); lons = rng.uniform(-180, 180, 60); ref = cyl_sample(64, lats, lons)
    best = None
    for lam_sign in (1, -1):
        for a in (1, -1):
            for b in (1, -1):
                for swap in (False, True):
                    x, y = polar_xy(hem, lats, lons, lam_sign, swap); col = lab['cx'] + a * x / lab['m']; row = lab['cy'] + b * y / lab['m']
                    v = map_coordinates(full, [row, col], order=1, mode='nearest'); err = float(np.sqrt(np.mean((v - ref) ** 2)))
                    if best is None or err < best[0]: best = (err, (lam_sign, a, b, swap))
    print(f'  polar orientation {hem}: {best[1]} rms vs LDEM_64 = {best[0] * 1000:.0f} m', flush=True)
    if best[0] > 0.35: raise RuntimeError('could not determine polar grid orientation')
    _orient[hem] = best[1]; return best[1]


# ------------------------------------------------------------------ windows
def grid(lat0, lon0, half_km, cell_km, exact=False):
    """Latitude/longitude of every cell of an east/north grid centred on the site. exact=True places cells on the true sphere around the site
    (great-circle offsets, valid right up to the pole); exact=False uses the flat lat/lon approximation the app's regional maps use."""
    n = int(round(2 * half_km / cell_km)); xs = (np.arange(n) + 0.5 - n / 2) * cell_km; X, Y = np.meshgrid(xs, xs)
    if not exact:
        return n, lat0 + np.degrees(Y / RM), lon0 + np.degrees(X / (RM * math.cos(math.radians(lat0))))
    p0, d, th = math.radians(lat0), np.hypot(X, Y) / RM, np.arctan2(X, Y)
    lat = np.arcsin(np.sin(p0) * np.cos(d) + np.cos(p0) * np.sin(d) * np.cos(th))
    lon = math.radians(lon0) + np.arctan2(np.sin(th) * np.sin(d) * np.cos(p0), np.cos(d) - np.sin(p0) * np.sin(lat))
    return n, np.degrees(lat), (np.degrees(lon) + 180) % 360 - 180


def pick_local(lat):
    a = abs(lat); hem = 'S' if lat < 0 else 'N'
    if a >= 75: return ('polar', hem, 75, 30, 0.03)
    if a >= 60: return ('polar', hem, 60, 60, 0.06)
    if a >= 45: return ('polar', hem, 45, 100, 0.10)
    return ('cyl', None, 512, 59, 0.06)


def local_window(lat0, lon0, half_km=12.0):
    """Highest-resolution real DEM around a site. Returns (heights km n x n, meta)."""
    kind, hem, p, res, cell = pick_local(lat0); n, lat, lon = grid(lat0, lon0, half_km, cell, exact=True)
    if kind == 'polar': h = polar_sample(hem, POLAR[(hem, p, res)], lat, lon, find_orient(hem)); src = POLAR[(hem, p, res)]
    else: h = cyl_sample(512, lat, lon); src = 'LDEM_512'
    return h.astype(np.float32), {'n': n, 'cell': cell, 'half': half_km, 'source': src, 'res_m': res}


def regional_window(lat0, lon0, half_km=52.0, cell_km=0.5):
    n, lat, lon = grid(lat0, lon0, half_km, cell_km)
    if abs(lat0) >= 80:
        hem = 'S' if lat0 < 0 else 'N'; h = polar_sample(hem, POLAR[(hem, 75, 240)], lat, lon, find_orient(hem)); src = POLAR[(hem, 75, 240)]
    else: h = cyl_sample(64, lat, lon); src = 'LDEM_64'
    return h.astype(np.float32), {'n': n, 'cell': cell_km, 'half': half_km, 'source': src, 'res_m': 473}


if __name__ == '__main__':
    # self-test against the crops already shipped in tex/ (Apollo 11 and the south pole)
    import json
    OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tex')
    meta = json.load(open(os.path.join(OUT, 'site_dems.json'))); old = np.fromfile(os.path.join(OUT, 'site_dems.bin'), '<i2').reshape(-1, 208, 208) * 0.0005
    h, m = regional_window(0.67, 23.47); print('regional Apollo 11 vs shipped crop: rms diff', float(np.sqrt(np.mean((h - old[0]) ** 2))) * 1000, 'm', m)
    h, m = local_window(0.67, 23.47); print('local Apollo 11', h.shape, float(h.min()), float(h.max()), m)
    h, m = local_window(-89.66, 127.8); print('local Shackleton', h.shape, float(h.min()), float(h.max()), m)
