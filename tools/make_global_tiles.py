#!/usr/bin/env python3
"""Cut NASA's global LOLA elevation grid (LDEM_128, 128 px/deg = 237 m at the equator, int16 x 0.5 m) into 4x4 degree tiles
that a static host (Firebase) can serve, so ANY lat/lon on the Moon has real terrain without the dev server.

usage: make_global_tiles.py path/to/ldem_128.img
Each tile is (512+2)^2 int16 (a 1 px overlap on the east/south edges makes bilinear/bicubic joins seamless), column-delta encoded, gzip'd.
Output: tex/global/t_<row>_<col>.bin.gz  (row 0 = 90N..86N, col 0 = 0E..4E, longitude measured 0..360 east) + tex/global/index.json
"""
import gzip, json, os, sys
import numpy as np

P = 128; T = 4; TP = T * P; H = 180 * P; W = 360 * P
src = sys.argv[1]
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tex', 'global'); os.makedirs(out, exist_ok=True)
img = np.memmap(src, dtype='<i2', mode='r', shape=(H, W))
rows, cols = H // TP, W // TP; total = 0
for r in range(rows):
    band = np.asarray(img[r * TP:min(H, (r + 1) * TP + 1)])
    if band.shape[0] < TP + 1: band = np.vstack([band, band[-1:]])             # south pole row: repeat
    for c in range(cols):
        idx = (np.arange(c * TP, (c + 1) * TP + 1)) % W
        tile = band[:, idx].astype('<i2')
        d = np.empty_like(tile); d[:, 0] = tile[:, 0]; d[:, 1:] = tile[:, 1:] - tile[:, :-1]   # column delta (wraps int16, undone the same way)
        blob = gzip.compress(d.astype('<i2').tobytes(), 9, mtime=0)
        open(os.path.join(out, f't_{r}_{c}.bin.gz'), 'wb').write(blob); total += len(blob)
    print(f'row {r + 1}/{rows}  {total / 1e6:.0f} MB', flush=True)
json.dump({'ppd': P, 'tile_deg': T, 'n': TP + 1, 'scale': 0.0005, 'rows': rows, 'cols': cols, 'source': 'LRO LOLA LDEM_128 (NASA PDS)', 'res_m': 237}, open(os.path.join(out, 'index.json'), 'w'))
print('done', total / 1e6, 'MB')
