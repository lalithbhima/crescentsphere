#!/usr/bin/env python3
"""Download real spacecraft trajectories from NASA/JPL Horizons and pack them for the app (tex/missions.bin + tex/missions.json).

Each path is converted into the Earth-Moon rotating frame: origin at Earth's centre, x toward the Moon, z along the Moon's orbit normal,
and lengths scaled by 384400 km / (Earth-Moon distance at that moment) so every path meets the Moon wherever the Moon happens to be today.
bin layout per mission: N rows of float32 (days since start, x, y, z) with x, y, z in km at the mean Earth-Moon distance.
"""
import json, math, os, struct, sys, time, urllib.parse, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from horizons_fetch import API, UA

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tex')
D, RMOON = 384400.0, 1737.4
# id, Horizons target, name, short, start, stop, step, group, what it was
M = [
 ('artemis1', '-1023', 'Artemis I', '2022', '2022-11-16 08:50', '2022-12-11 17:00', '1h', 'NASA', 'Uncrewed Orion test flight launched on the SLS rocket. It flew past the Moon, entered a distant retrograde orbit and returned to Earth.'),
 ('artemis2', '-1024', 'Artemis II', '2026', '2026-04-02 02:00', '2026-04-10 23:50', '1h', 'NASA', 'Crewed Orion flight around the Moon and back.'),
 ('capstone', '-1176', 'CAPSTONE', '2022', '2022-06-29 00:00', '2023-01-10 00:00', '4h', 'NASA', 'Small satellite that tested the near-rectilinear halo orbit planned for the Gateway station, reached by a low-energy transfer.'),
 ('danuri', '-155', 'Danuri (KPLO)', '2022', '2022-08-05 00:00', '2023-01-01 00:00', '6h', 'Korea', "South Korea's first lunar orbiter, sent on a low-energy ballistic transfer of about four and a half months."),
 ('slim', '-240', 'SLIM', '2023', '2023-09-08 00:00', '2024-01-20 00:00', '6h', 'Japan', "Japan's Smart Lander for Investigating Moon: a long, fuel-saving transfer, lunar orbit, then a precision landing in January 2024."),
 ('ch3', '-158', 'Chandrayaan-3 lander', '2023', '2023-07-14 09:30', '2023-08-24 00:00', '1h', 'India', "India's lander. Several Earth-orbit raising burns, trans-lunar injection, then the landing near the south pole on 23 August 2023."),
 ('ch2', '-153', 'Chandrayaan-2 lander', '2019', '2019-07-22 09:35', '2019-09-06 20:00', '2h', 'India', "India's Vikram lander, which came down hard during its landing attempt on 6 September 2019."),
 ('ladee', '-12', 'LADEE', '2013', '2013-09-07 04:00', '2013-11-15 00:00', '4h', 'NASA', 'Lunar Atmosphere and Dust Environment Explorer, an orbiter that studied the thin lunar exosphere.'),
 ('a8', '-399080', 'Apollo 8 rocket stage', '1968', '1968-12-21 16:10', '1968-12-31 00:00', '1h', 'Apollo', 'The Saturn V third stage (S-IVB) after it sent Apollo 8 toward the Moon. Horizons holds the stage, not the capsule.'),
 ('a10', '-399100', 'Apollo 10 rocket stage', '1969', '1969-05-18 19:50', '1969-05-29 00:00', '1h', 'Apollo', 'The Saturn V third stage (S-IVB) after it sent Apollo 10 toward the Moon.'),
 ('a11', '-399110', 'Apollo 11 rocket stage', '1969', '1969-07-16 16:45', '1969-07-28 00:00', '1h', 'Apollo', 'The Saturn V third stage (S-IVB) after it sent Apollo 11 toward the Moon. The crew left it behind, so this is the outbound leg only.'),
 ('a12', '-399120', 'Apollo 12 rocket stage', '1969', '1969-11-14 19:35', '1969-12-06 00:00', '1h', 'Apollo', 'The Saturn V third stage (S-IVB) after it sent Apollo 12 toward the Moon.'),
]


def table(cmd, start, stop, step, tbl):
    q = {'format': 'json', 'COMMAND': f"'{cmd}'", 'OBJ_DATA': "'NO'", 'MAKE_EPHEM': "'YES'", 'EPHEM_TYPE': "'VECTORS'", 'CENTER': "'500@399'", 'START_TIME': f"'{start}'", 'STOP_TIME': f"'{stop}'",
         'STEP_SIZE': f"'{step}'", 'CSV_FORMAT': "'YES'", 'VEC_TABLE': f"'{tbl}'", 'REF_PLANE': "'FRAME'", 'REF_SYSTEM': "'ICRF'", 'OUT_UNITS': "'KM-S'", 'TIME_TYPE': "'UT'", 'VEC_CORR': "'NONE'"}
    for k in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(API + '?' + urllib.parse.urlencode(q), headers=UA), timeout=180) as r:
                d = json.loads(r.read())
            res = d.get('result', ''); a, b = res.index('$$SOE'), res.index('$$EOE')
            return [[x.strip() for x in ln.split(',')] for ln in res[a + 5:b].strip().splitlines()]
        except Exception as e:
            print('  retry', k + 1, e, file=sys.stderr); time.sleep(3 * (k + 1))
    raise SystemExit('failed ' + cmd)


def cross(a, b): return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
def dot(a, b): return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
def unit(a):
    n = math.sqrt(dot(a, a)); return [x / n for x in a]


def main():
    buf, meta = bytearray(), []
    for (mid, cmd, name, year, start, stop, step, grp, what) in M:
        S = table(cmd, start, stop, step, '1'); Mo = table(301, start, stop, step, '2')
        n = min(len(S), len(Mo)); rows = []; maxE = 0; minAlt = 1e18; tMin = None; jd0 = float(S[0][0])
        for i in range(n):
            sp = [float(x) for x in S[i][2:5]]; mp = [float(x) for x in Mo[i][2:5]]; mv = [float(x) for x in Mo[i][5:8]]
            dm = math.sqrt(dot(mp, mp)); X = [c / dm for c in mp]; Z = unit(cross(mp, mv)); Y = cross(Z, X); k = D / dm
            rows.append((float(S[i][0]) - jd0, dot(sp, X) * k, dot(sp, Y) * k, dot(sp, Z) * k))
            e = math.sqrt(dot(sp, sp)); maxE = max(maxE, e)
            alt = math.sqrt(sum((sp[j] - mp[j]) ** 2 for j in range(3))) - RMOON
            if alt < minAlt: minAlt, tMin = alt, float(S[i][0]) - jd0
        # refine the closest approach with 1-minute samples around the hourly minimum
        try:
            a, b = jd0 + tMin - 0.08, jd0 + tMin + 0.08
            S2 = table(cmd, f'JD {a:.6f}', f'JD {b:.6f}', '1m', '1'); M2 = table(301, f'JD {a:.6f}', f'JD {b:.6f}', '1m', '1')
            for i in range(min(len(S2), len(M2))):
                sp = [float(x) for x in S2[i][2:5]]; mp = [float(x) for x in M2[i][2:5]]
                alt = math.sqrt(sum((sp[j] - mp[j]) ** 2 for j in range(3))) - RMOON
                if alt < minAlt: minAlt, tMin = alt, float(S2[i][0]) - jd0
        except SystemExit: pass
        for r in rows: buf += struct.pack('<4f', *r)
        meta.append({'id': mid, 'name': name, 'year': year, 'start': S[0][1].replace('A.D. ', ''), 'stop': S[n - 1][1].replace('A.D. ', ''), 'n': n, 'days': rows[-1][0], 'group': grp, 'what': what,
                     'maxEarthKm': maxE, 'minMoonAltKm': minAlt, 'minMoonDay': tMin, 'target': cmd})
        print(f'{name:<26} {n:>5} pts  {rows[-1][0]:7.1f} d  max from Earth {maxE:>10,.0f} km  closest to Moon {minAlt:>9,.0f} km (altitude)', flush=True)
        time.sleep(1)
    off = 0
    for m in meta: m['offset'] = off; off += m['n']
    open(os.path.join(OUT, 'missions.bin'), 'wb').write(buf)
    json.dump({'source': 'NASA/JPL Horizons API, spacecraft ephemerides; Earth-Moon rotating frame, scaled to 384400 km', 'missions': meta}, open(os.path.join(OUT, 'missions.json'), 'w'), indent=1)
    print('wrote', off, 'rows,', len(buf) / 1e3, 'KB')


if __name__ == '__main__':
    main()
