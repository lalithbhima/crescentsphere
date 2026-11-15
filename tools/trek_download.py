#!/usr/bin/env python3
"""Download every NASA Moon Trek data product that covers a lat/lon box, cropped to that box.

Moon Trek's own cart makes you re-select products one batch at a time and its global files are huge
(for the Apollo 11 box the 74 matching products add up to ~45 GB). This script asks Trek's search service
for every product that intersects the box, then uses Trek's subset service to download only a small
region around it, as a GeoTIFF.

Trek's subset service returns wrong data for boxes smaller than about one degree (it silently falls back to
some other area), so the request is always padded to at least --min-span degrees (default 1.0, about 30 km)
centred on your box. Products that have no real data there (for example the Apollo 16 elevation model at the
Apollo 11 site) are detected and skipped.

Usage:
  python3 tools/trek_download.py                       # Apollo 11 box, everything
  python3 tools/trek_download.py --list                # just list what would be downloaded
  python3 tools/trek_download.py --bbox 30.5 20.0 31.0 20.4 --out trek_downloads/apollo17
  python3 tools/trek_download.py --only Diviner --only LOLA
  python3 tools/trek_download.py --extra LRO_NAC_Apollo11_Mosaic_p --max-px 4096
"""
import argparse, json, math, os, re, sys, time, urllib.parse, urllib.request

BASE = 'https://trek.nasa.gov/moon'
SEARCH = BASE + '/TrekServices/ws/index/moon/eq/searchRaster'
SUBSET = BASE + '/TrekWS/rest/transform/latlon/subset/stream/tiff'
UA = {'User-Agent': 'moon-trek-bulk-subset/1.0 (personal research use)'}


def get(url, timeout=180, tries=3):
    err = None
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                return r.read(), r.headers.get('Content-Type', '')
        except Exception as e:  # network hiccup: wait and retry
            err = e; time.sleep(2 * (k + 1))
    raise err


def valid_fraction(body):
    """Share of pixels that hold real data (not Trek's no-data fill values). None if Pillow/numpy are missing."""
    try:
        import io, numpy as np
        from PIL import Image
        arr = np.array(Image.open(io.BytesIO(body))).astype('float64')
        good = np.isfinite(arr) & (arr > -32766.5) & (arr > -1e30)
        if not good.any() or np.ptp(arr[good]) == 0: return 0.0  # empty or constant fill: the product has no coverage here
        return float(np.mean(good))
    except Exception:
        return None


def ppd_of(doc):
    """Native pixels per degree, from the product label, title or description (falls back to 128)."""
    for text in (doc.get('productLabel', ''), doc.get('title', ''), doc.get('description', '')):
        m = re.search(r'(\d+)\s*ppd', text, re.I) or re.search(r'(\d+)\s*pix(?:els)?\s*/\s*deg', text, re.I) or re.search(r'_(\d{2,4})_jp2', text) or re.search(r'cyl_(\d{2,4})', text)
        if m: return int(m.group(1))
    m = re.search(r'([\d.]+)\s*m(?:eters)?\s*(?:/|per)\s*pix', doc.get('description', ''), re.I)
    if m: return max(1, round(30.3e3 / float(m.group(1))))  # 1 degree ~ 30.3 km at the equator
    return 128


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--bbox', nargs=4, type=float, metavar=('MINLON', 'MINLAT', 'MAXLON', 'MAXLAT'), default=[23.449129, 0.636660, 23.526120, 0.707298], help='default: the Apollo 11 view from the Trek link')
    ap.add_argument('--out', default='trek_downloads/apollo11')
    ap.add_argument('--min-span', type=float, default=1.0, help='smallest region (degrees per side) to request; Trek returns garbage below about 0.5')
    ap.add_argument('--max-px', type=int, default=2048, help='longest side of each cropped image in pixels (native resolution is used when smaller)')
    ap.add_argument('--only', action='append', default=[], help='keep products whose label or title contains this text (repeatable)')
    ap.add_argument('--extra', action='append', default=[], help='extra Trek layer label to crop (e.g. an image mosaic that the data search does not list)')
    ap.add_argument('--list', action='store_true', help='list the products and exit')
    a = ap.parse_args()
    bx0, by0, bx1, by1 = a.bbox
    cx, cy, half = (bx0 + bx1) / 2, (by0 + by1) / 2, max((bx1 - bx0) / 2, (by1 - by0) / 2, a.min_span / 2)
    x0, x1, y0, y1 = cx - half, cx + half, cy - half, cy + half

    q = urllib.parse.urlencode({'bbox': f'{bx0},{by0},{bx1},{by1}', 'rows': 2000, 'start': 0, 'key': '*', 'intersects': 'true'})
    docs = json.loads(get(SEARCH + '?' + q)[0])['response']['docs']
    seen, items = set(), []
    for d in docs:
        if d['productLabel'] in seen: continue
        seen.add(d['productLabel'])
        hay = (d['productLabel'] + ' ' + d.get('title', '')).lower()
        if a.only and not any(o.lower() in hay for o in a.only): continue
        items.append(d)
    for lab in a.extra: items.append({'productLabel': lab, 'title': lab, 'description': '', 'productCat1': 'Extra', 'fileSize': [0]})
    items.sort(key=lambda d: (str(d.get('productCat1')), d['productLabel']))
    full = sum((d.get('fileSize') or [0])[0] for d in items)
    print(f'{len(items)} products cover the box; their full global files would be {full / 1e9:.1f} GB. Downloading only a {2 * half:.2f} degree square around lon {cx:.3f}, lat {cy:.3f}.')
    if a.list:
        for d in items: print(f"  {str(d.get('productCat1')):<14} {d['productLabel']}  |  {d.get('title', '')}")
        return
    os.makedirs(a.out, exist_ok=True); manifest, ok, bad, total, skipped = [], 0, [], 0, []
    for n, d in enumerate(items, 1):
        lab = d['productLabel']; ppd = ppd_of(d)
        w = max(8, min(a.max_px, math.ceil((x1 - x0) * ppd))); h = max(8, min(a.max_px, math.ceil((y1 - y0) * ppd)))
        fn = os.path.join(a.out, re.sub(r'[^\w.\-]+', '_', lab) + '.tif')
        rec = {'label': lab, 'title': d.get('title'), 'category': d.get('productCat1'), 'subcategory': d.get('productCat2'), 'mission': d.get('mission'), 'instrument': d.get('instrument'), 'native_ppd': ppd, 'width': w, 'height': h, 'region': [x0, y0, x1, y1], 'file': os.path.basename(fn), 'description': d.get('description')}
        if os.path.exists(fn) and os.path.getsize(fn) > 1000:
            print(f'[{n}/{len(items)}] have   {lab}'); ok += 1; total += os.path.getsize(fn); manifest.append(rec); continue
        qs = urllib.parse.urlencode({'src': lab, 'ulx': x0, 'uly': y1, 'lrx': x1, 'lry': y0, 'xOutSz': w, 'yOutSz': h})
        try:
            body, ctype = get(SUBSET + '?' + qs)
            if b'II*' not in body[:4] and b'MM\x00*' not in body[:4]: raise RuntimeError('not a TIFF: ' + body[:120].decode('latin1').strip())
            vf = valid_fraction(body); rec['valid_fraction'] = vf
            if vf is not None and vf == 0: skipped.append(lab); print(f'[{n}/{len(items)}] skip   {lab}: no real data in this area'); continue
            open(fn, 'wb').write(body); ok += 1; total += len(body); manifest.append(rec)
            print(f'[{n}/{len(items)}] saved  {lab}  {w}x{h}  {len(body) / 1e6:.2f} MB' + (f'  ({vf * 100:.0f}% valid)' if vf is not None else ''))
        except Exception as e:
            bad.append(lab); print(f'[{n}/{len(items)}] FAILED {lab}: {e}', file=sys.stderr)
        time.sleep(0.25)
    json.dump(manifest, open(os.path.join(a.out, 'manifest.json'), 'w'), indent=1)
    print(f'\nDone: {ok} saved ({total / 1e6:.1f} MB) in {a.out}; {len(bad)} failed.')
    if skipped: print(f'Skipped {len(skipped)} products with no data here:', ', '.join(skipped))
    if bad: print('Failed:', ', '.join(bad))


if __name__ == '__main__':
    main()
