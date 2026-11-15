#!/usr/bin/env python3
"""Rise / set times of the Sun and Earth at every site in js/sites.js, straight from NASA/JPL Horizons (spherical Moon, no terrain).

Horizons API, EPHEM_TYPE=OBSERVER from a lunar surface coordinate (CENTER='coord@301'), R_T_S_ONLY=YES, STEP_SIZE='3m GEO'.
The app compares its own flat-horizon crossings with these (Researcher mode, "Horizons check"). Output: tex/horizons_rts.json
"""
import calendar, json, os, re, sys, time, urllib.parse, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from horizons_fetch import API, UA

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
START, STOP = '2026-11-01 00:00', '2027-03-01 00:00'
MON = {m: i for i, m in enumerate(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], 1)}


def sites():
    src = open(os.path.join(ROOT, 'js', 'sites.js')).read()
    return [(m.group(1), float(m.group(2)), float(m.group(3))) for m in re.finditer(r"S\('(\w+)',\s*(?:'[^']*'|\"[^\"]*\"),\s*'\w+',\s*(-?[\d.]+),\s*(-?[\d.]+)", src)]


def jd_of(s):  # '2026-Nov-15 01:24' (UT) -> JD
    d, t = s.split(); y, mo, da = d.split('-'); hh, mm = t.split(':')
    return calendar.timegm((int(y), MON[mo], int(da), int(hh), int(mm), 0)) / 86400 + 2440587.5


def events(cmd, lat, lon):
    q = {'format': 'json', 'COMMAND': f"'{cmd}'", 'OBJ_DATA': "'NO'", 'MAKE_EPHEM': "'YES'", 'EPHEM_TYPE': "'OBSERVER'", 'CENTER': "'coord@301'", 'COORD_TYPE': "'GEODETIC'", 'SITE_COORD': f"'{lon},{lat},0'",
         'START_TIME': f"'{START}'", 'STOP_TIME': f"'{STOP}'", 'STEP_SIZE': "'3m GEO'", 'R_T_S_ONLY': "'YES'", 'QUANTITIES': "'4'", 'ANG_FORMAT': "'DEG'", 'CSV_FORMAT': "'YES'", 'TIME_DIGITS': "'MINUTES'", 'REF_SYSTEM': "'ICRF'"}
    for k in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(API + '?' + urllib.parse.urlencode(q), headers=UA), timeout=240) as r:
                res = json.loads(r.read()).get('result', '')
            if '$$SOE' not in res: return []          # no events in the window (for example Earth never rises or sets)
            a, b = res.index('$$SOE'), res.index('$$EOE'); out = []
            for ln in res[a + 5:b].strip().splitlines():
                f = [x.strip() for x in ln.split(',')]
                if len(f) > 2 and f[2] in ('r', 's'): out.append([round(jd_of(f[0]), 5), f[2]])
            return out
        except Exception as e:
            print('  retry', k + 1, e, file=sys.stderr); time.sleep(3 * (k + 1))
    return None


def main():
    res = {}
    for sid, lat, lon in sites():
        if sid == 'custom' or sid.startswith('t_'): continue   # curated landing sites only; the terrain-feature sites add little here
        s, e = events(10, lat, lon), events(399, lat, lon)
        res[sid] = {'lat': lat, 'lon': lon, 'sun': s, 'earth': e}
        print(f'{sid:<16} sun {len(s or []):>3} events, earth {len(e or []):>3}', flush=True); time.sleep(0.5)
    json.dump({'source': 'NASA/JPL Horizons API, rise/transit/set from a lunar surface point (geometric horizon, spherical Moon)', 'window': [START, STOP], 'sites': res}, open(os.path.join(ROOT, 'tex', 'horizons_rts.json'), 'w'))
    print('wrote', len(res), 'sites')


if __name__ == '__main__':
    main()
