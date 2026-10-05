# Dev server with real cache busting.
#
# Run from the project root:   MR_ROOT="$PWD" python3 tools/serve.py
#
# no-store alone is not enough: the browser keeps an ES module map keyed by URL,
# so a reloaded page happily re-executes the module it already has. This
# rewrites every relative import to carry a build stamp derived from the newest
# file on disk, which makes each edit a genuinely new URL.
import http.server, socketserver, os, re, pathlib, time, io

ROOT = pathlib.Path(os.environ['MR_ROOT'])
IMPORT_RE = re.compile(rb"""(from\s+|import\s*\(\s*)(['"])(\.{1,2}/[^'"]+?\.js)(['"])""")
# Allow (and replace) any query the source already carries.
SCRIPT_RE = re.compile(rb'''(<script[^>]*src=")([^"?]+?\.js)(\?[^"]*)?(")''')

# Source now lives in several trees (js/, track-blocks/, ui-assets/), so the
# stamp has to walk all of them. Globbing js/*.js alone would leave every
# edit under track-blocks/ or ui-assets/ served from the browser's module
# cache -- the exact stale-module trap this server exists to prevent.
SRC_DIRS = ('js', 'track-blocks', 'ui-assets', 'MarbleRush2D')

def stamp():
    newest = 0
    for d in SRC_DIRS:
        for p in (ROOT / d).rglob('*.js'):
            newest = max(newest, p.stat().st_mtime_ns)
    for p in ROOT.glob('*.html'):
        newest = max(newest, p.stat().st_mtime_ns)
    return str(newest)[-10:].encode()

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        super().end_headers()

    def send_head(self):
        path = self.translate_path(self.path)
        # A request for "/" translates to the DIRECTORY, so the .html branch
        # below never fired for the page you actually load, and the entry
        # <script src> went out unstamped -- the one module the cache buster
        # was failing to bust.
        if os.path.isdir(path):
            index = os.path.join(path, 'index.html')
            if os.path.isfile(index):
                path = index
        if path.endswith('.html') and os.path.isfile(path):
            v = str(time.time_ns())[-10:].encode()
            body = SCRIPT_RE.sub(lambda m: m.group(1) + m.group(2) + b'?v=' + v + m.group(4),
                                 open(path, 'rb').read())
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            return io.BytesIO(body)

        if path.endswith('.js') and os.path.isfile(path):
            v = stamp()
            body = open(path, 'rb').read()
            body = IMPORT_RE.sub(lambda m: m.group(1) + m.group(2) + m.group(3) + b'?v=' + v + m.group(4), body)
            self.send_response(200)
            self.send_header('Content-Type', 'text/javascript')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            return io.BytesIO(body)
        return super().send_head()

    def log_message(self, *a):
        pass

os.chdir(ROOT)
socketserver.TCPServer.allow_reuse_address = True
# Port is overridable because the 2D brief asked for :8000, while everything
# written down so far says :8080.   MR_PORT=8000 python3 tools/serve.py
PORT = int(os.environ.get('MR_PORT', '8080'))
with socketserver.TCPServer(('127.0.0.1', PORT), Handler) as httpd:
    print(f'MarbleRush dev server on http://localhost:{PORT}/')
    print(f'  2D  http://localhost:{PORT}/?v=2D')
    print(f'  3D  http://localhost:{PORT}/?v=3D')
    httpd.serve_forever()
