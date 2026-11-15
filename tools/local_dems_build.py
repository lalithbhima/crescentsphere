#!/usr/bin/env python3
"""Build a high-resolution real LOLA elevation window (24 km square) for every site in js/sites.js -> tex/local/<id>.bin + tex/local_dems.json.
int16, 0.0005 km per step above the 1737.4 km sphere, row j = north, column i = east (same convention as site_dems.bin)."""
import json, os, re, sys, time
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lola_local as L

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'); OUT = os.path.join(ROOT, 'tex', 'local'); os.makedirs(OUT, exist_ok=True)


def sites():
    src = open(os.path.join(ROOT, 'js', 'sites.js')).read()
    return [(m.group(1), float(m.group(2)), float(m.group(3))) for m in re.finditer(r"S\('(\w+)',\s*(?:'[^']*'|\"[^\"]*\"),\s*'\w+',\s*(-?[\d.]+),\s*(-?[\d.]+)", src)]


def main():
    metaf = os.path.join(ROOT, 'tex', 'local_dems.json'); meta = json.load(open(metaf)) if os.path.exists(metaf) else {}
    for sid, lat, lon in sites():
        if sid in meta and os.path.exists(os.path.join(OUT, sid + '.bin')): continue
        t = time.time(); h, m = L.local_window(lat, lon)
        dn = np.round(h / 0.0005); assert np.abs(dn).max() < 32000
        dn.astype('<i2').tofile(os.path.join(OUT, sid + '.bin'))
        meta[sid] = {**m, 'lat': lat, 'lon': lon, 'relief_km': float(h.max() - h.min())}
        json.dump(meta, open(metaf, 'w'))
        print(f'{sid:<16} {m["source"]:<22} {m["res_m"]:>3} m  {m["n"]}x{m["n"]}  relief {h.max() - h.min():5.2f} km  {time.time() - t:5.1f} s', flush=True)
    print('done', len(meta), 'sites')


if __name__ == '__main__':
    main()
