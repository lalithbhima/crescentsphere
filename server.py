#!/usr/bin/env python3
"""Tiny static server (no caching, correct JS MIME types).  Usage: python3 server.py [port]"""
import http.server, socketserver, sys, os, json, urllib.parse
HERE = os.path.dirname(os.path.abspath(__file__)); os.chdir(HERE); sys.path.insert(0, os.path.join(HERE, 'tools'))
CACHE = os.path.join(HERE, 'tex', 'cache')


def dem_response(qs):
    """/api/dem?kind=local|regional&lat=..&lon=.. : real LOLA terrain cut on demand (tools/lola_local.py), cached on disk. Returns (meta, int16 bytes)."""
    import numpy as np, lola_local as L
    kind = qs.get('kind', ['local'])[0]; lat = float(qs['lat'][0]); lon = float(qs['lon'][0]); lon = (lon + 180) % 360 - 180
    if kind not in ('local', 'regional') or not (-90 <= lat <= 90): raise ValueError('bad request')
    os.makedirs(CACHE, exist_ok=True); stem = os.path.join(CACHE, f'{kind}_{lat:.3f}_{lon:.3f}')
    if os.path.exists(stem + '.bin') and os.path.exists(stem + '.json'): return json.load(open(stem + '.json')), open(stem + '.bin', 'rb').read()
    h, meta = L.local_window(lat, lon) if kind == 'local' else L.regional_window(lat, lon)
    body = np.round(h / 0.0005).astype('<i2').tobytes(); open(stem + '.bin', 'wb').write(body); json.dump(meta, open(stem + '.json', 'w'))
    return meta, body

class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.mjs': 'text/javascript'}
    def do_GET(self):
        if self.path.startswith('/api/dem'):
            try:
                meta, body = dem_response(urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query))
                self.send_response(200); self.send_header('Content-Type', 'application/octet-stream'); self.send_header('X-Dem-Meta', json.dumps(meta)); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
            except Exception as e:
                msg = str(e).encode(); self.send_response(503); self.send_header('Content-Length', str(len(msg))); self.end_headers(); self.wfile.write(msg)
            return
        super().do_GET()
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store'); super().end_headers()
    def log_message(self, *a): pass
port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
socketserver.TCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(('', port), H) as s:
    print(f'Lunar Navigator on http://localhost:{port}'); s.serve_forever()
