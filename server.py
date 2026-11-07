"""Serve the demo. stdlib only - no FastAPI, no install step.

    python3 server.py            -> http://127.0.0.1:8765
"""

from __future__ import annotations

import json
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import analyze
import forecast

HOST = "127.0.0.1"
PORT = int(os.environ.get("PORT", "8765"))
STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=STATIC, **kw)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/api/data", "/api/data/"):
            self._json(analyze.payload())
            return
        if path in ("/api/forecast", "/api/forecast/"):
            self._json(forecast.payload())
            return
        if self.path == "/":
            self.path = "/index.html"
        super().do_GET()

    def _json(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        if self.path.endswith((".js", ".css", ".html")):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            return
        super().log_message(fmt, *args)


def main():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"serving http://{HOST}:{PORT}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
