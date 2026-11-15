#!/usr/bin/env python3
"""Download the Moon/Sun/Earth geometry from NASA/JPL Horizons (DE441) and pack it for the app.

Horizons API: https://ssd-api.jpl.nasa.gov/doc/horizons.html. Three tables per year, 2-hour steps, geocentric (500@399):
  OBSERVER, target Moon: Q14 Earth sub-point lon/lat (libration), Q15 Sun sub-point lon/lat, Q17 north-pole position angle,
                         Q19 Moon-Sun range and range rate, Q20 Earth-Moon range and range rate
  VECTORS,  target Moon: position and velocity (ICRF equatorial, km, km/s)
  VECTORS,  target Sun : position
Everything is MOON_ME (mean Earth / polar axis) based, east-positive longitudes. The Moon's orientation is reconstructed from the
sub-Earth point plus the pole position angle and checked against the sub-Sun point (printed at the end).

Outputs in tex/:
  horizons_moon.bin   float32 x8: Sun dir xyz, Earth dir xyz (Moon body frame), Moon-Sun km, Earth-Moon km
  horizons_scene.bin  float32 x21: Moon pos xyz, Sun pos xyz, Moon vel xyz (geocentric, mean ecliptic of date, km, km/s),
                                   Moon body axes x,y,pole (3 each, ecliptic of date), Moon-Sun range rate, Earth-Moon range rate, Earth-Sun range rate (km/s)
  horizons_moon.json  metadata
"""
import json, math, os, struct, sys, time, urllib.parse, urllib.request, datetime as dt
API = 'https://ssd.jpl.nasa.gov/api/horizons.api'
AU = 149597870.7
Y0, Y1 = 2025, 2041            # 2025-01-01 .. 2041-01-01 UT, 2-hour steps (matches the app's series)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tex')
UA = {'User-Agent': 'lunar-navigator-ephemeris/1.0'}


def call(q):
    for k in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(API + '?' + urllib.parse.urlencode(q), headers=UA), timeout=180) as r:
                d = json.loads(r.read())
            if 'result' not in d: raise RuntimeError(d.get('error') or d)
            res = d['result']; a, b = res.index('$$SOE'), res.index('$$EOE')
            return [[x.strip() for x in ln.split(',')] for ln in res[a + 5:b].strip().splitlines()]
        except Exception as e:
            print('  retry', k + 1, e, file=sys.stderr); time.sleep(3 * (k + 1))
    raise SystemExit('Horizons request failed')


def base(start, stop, cmd, kind):
    q = {'format': 'json', 'COMMAND': f"'{cmd}'", 'OBJ_DATA': "'NO'", 'MAKE_EPHEM': "'YES'", 'EPHEM_TYPE': f"'{kind}'", 'CENTER': "'500@399'",
         'START_TIME': f"'{start}'", 'STOP_TIME': f"'{stop}'", 'STEP_SIZE': "'2h'", 'CSV_FORMAT': "'YES'"}
    return q


def year(y):
    start = f'{y}-01-01 00:00'; stop = f'{y + 1}-01-01 00:00' if y == Y1 - 1 else f'{y}-12-31 22:00'
    o = base(start, stop, 301, 'OBSERVER'); o.update({'QUANTITIES': "'14,15,17,19,20'", 'ANG_FORMAT': "'DEG'", 'TIME_DIGITS': "'MINUTES'"})
    m = base(start, stop, 301, 'VECTORS'); m.update({'VEC_TABLE': "'2'", 'REF_PLANE': "'FRAME'", 'REF_SYSTEM': "'ICRF'", 'OUT_UNITS': "'KM-S'", 'TIME_TYPE': "'UT'", 'VEC_CORR': "'LT'"})
    s = base(start, stop, 10, 'VECTORS'); s.update({'VEC_TABLE': "'2'", 'REF_PLANE': "'FRAME'", 'REF_SYSTEM': "'ICRF'", 'OUT_UNITS': "'KM-S'", 'TIME_TYPE': "'UT'", 'VEC_CORR': "'LT'"})
    exp = (366 if y % 4 == 0 else 365) * 12 + (1 if y == Y1 - 1 else 0)
    O, M, S = call(o), call(m), call(s)
    if not (len(O) == len(M) == len(S) == exp): raise SystemExit(f'{y}: expected {exp} rows, got {len(O)}/{len(M)}/{len(S)}')
    return O, M, S


# ---- small vector helpers
sub = lambda a, b: [a[i] - b[i] for i in range(3)]
dot = lambda a, b: a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
cross = lambda a, b: [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
scl = lambda a, k: [x * k for x in a]
add = lambda *vs: [sum(v[i] for v in vs) for i in range(3)]
def unit(a):
    n = math.sqrt(dot(a, a)); return [x / n for x in a]
def vec(lon, lat):
    lo, la = math.radians(lon), math.radians(lat); return [math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la)]


def precess(v, T):
    """ICRF/J2000 equatorial -> mean equator and equinox of date (IAU 1976 precession angles zeta, z, theta; checked against the Sun's
    ecliptic latitude (0.000 deg) and Meeus' solar longitude (within 0.006 deg) on four dates)."""
    s = -math.pi / 648000
    zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T ** 3) * s; z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T ** 3) * s
    th = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T ** 3) * s
    cz, sz, ct, st, cx, sx = math.cos(zeta), math.sin(zeta), math.cos(th), math.sin(th), math.cos(z), math.sin(z)
    x1 = cz * v[0] + sz * v[1]; y1 = -sz * v[0] + cz * v[1]; z1 = v[2]
    x2 = ct * x1 + st * z1; y2 = y1; z2 = -st * x1 + ct * z1
    return [cx * x2 + sx * y2, -sx * x2 + cx * y2, z2]


def to_ecl_date(v, T):
    """ICRF equatorial -> mean ecliptic of date."""
    x3, y3, z3 = precess(v, T); eps = (23.43929111 - 0.0130041667 * T) * math.pi / 180
    return [x3, y3 * math.cos(eps) + z3 * math.sin(eps), -y3 * math.sin(eps) + z3 * math.cos(eps)]


def pole_of_date(T):
    """Direction of the celestial pole of date, expressed in ICRF (third row of the precession matrix)."""
    return [precess(e, T)[2] for e in ([1, 0, 0], [0, 1, 0], [0, 0, 1])]


def orientation(moon, obs_lon, obs_lat, pa, pole):
    """Moon body axes (x, y, pole) in the same frame as `moon` (geocentric ICRF), from sub-Earth point and pole position angle."""
    d = unit(moon); L = scl(d, -1)                       # Moon -> Earth
    east = unit(cross(pole, d)); north = cross(d, east)   # position angle is measured from the celestial north of date
    ez = math.sin(math.radians(obs_lat)); pa = math.radians(pa)
    P = add(scl(L, ez), scl(add(scl(north, math.cos(pa)), scl(east, math.sin(pa))), math.sqrt(max(0, 1 - ez * ez))))
    P = unit(P); w = unit(sub(L, scl(P, ez))); g = cross(P, w); lo = math.radians(obs_lon)
    X = sub(scl(w, math.cos(lo)), scl(g, math.sin(lo))); Y = add(scl(g, math.cos(lo)), scl(w, math.sin(lo)))
    return X, Y, P


def main():
    A, B = bytearray(), bytearray(); jd0 = dt.datetime(Y0, 1, 1, tzinfo=dt.timezone.utc).timestamp() / 86400 + 2440587.5; k = 0; worst = 0
    for y in range(Y0, Y1):
        O, M, S = year(y); print(y, len(O), 'rows', flush=True)
        for o, m, s in zip(O, M, S):
            ol, ob, sl, sb, pa, r, rdot, de, dedot = (float(o[i]) for i in (3, 4, 5, 6, 7, 9, 10, 11, 12))
            mp, mv, sp, sv = [float(x) for x in m[2:5]], [float(x) for x in m[5:8]], [float(x) for x in s[2:5]], [float(x) for x in s[5:8]]
            esr = dot(sp, sv) / math.sqrt(dot(sp, sp))   # Earth-Sun range rate, km/s
            T = (jd0 + k / 12 - 2451545) / 36525; X, Y, P = orientation(mp, ol, ob, pa, pole_of_date(T))
            sd = unit(sub(sp, mp)); chk = vec(sl, sb); mine = [dot(sd, X), dot(sd, Y), dot(sd, P)]   # sub-solar direction rebuilt from the orientation
            worst = max(worst, math.degrees(math.acos(max(-1, min(1, dot(mine, chk))))))
            E = lambda v: to_ecl_date(v, T)
            A += struct.pack('<8f', *vec(sl, sb), *vec(ol, ob), r * AU, de * AU)
            B += struct.pack('<21f', *E(mp), *E(sp), *E(mv), *E(X), *E(Y), *E(P), rdot, dedot, esr); k += 1
        time.sleep(1)
    open(os.path.join(OUT, 'horizons_moon.bin'), 'wb').write(A); open(os.path.join(OUT, 'horizons_scene.bin'), 'wb').write(B)
    json.dump({'source': 'NASA/JPL Horizons API, DE441, target Moon (301), geocentric, frame MOON_ME', 'retrieved': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'), 'jd0': jd0, 'stepDays': 1 / 12, 'n': k,
               'fields': ['sunX', 'sunY', 'sunP', 'earthX', 'earthY', 'earthP', 'sunDistKm', 'earthDistKm'],
               'sceneFields': ['moonX', 'moonY', 'moonZ', 'sunX', 'sunY', 'sunZ', 'moonVx', 'moonVy', 'moonVz', 'axX', 'axY', 'axZ', 'ayX', 'ayY', 'ayZ', 'apX', 'apY', 'apZ', 'sunRangeRate', 'earthRangeRate', 'earthSunRangeRate'],
               'sceneFrame': 'geocentric mean ecliptic of date, km and km/s'}, open(os.path.join(OUT, 'horizons_moon.json'), 'w'), indent=1)
    print(f'wrote {k} samples; orientation check: worst sub-solar mismatch {worst:.4f} deg')


if __name__ == '__main__':
    main()
