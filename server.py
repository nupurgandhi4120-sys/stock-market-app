"""
Serve this folder and proxy Yahoo Finance GETs for the stock page (avoids browser CORS).

Usage (from this directory):
  python server.py

Then open http://localhost:8765/ or http://<your-machine-ip>:8765/
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = int(os.environ.get("PORT", "8000"))
ALLOWED_HOSTS = frozenset({"query1.finance.yahoo.com", "query2.finance.yahoo.com"})


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/yahoo":
            self._yahoo_proxy(parsed.query)
            return
        return SimpleHTTPRequestHandler.do_GET(self)

    def _yahoo_proxy(self, query: str) -> None:
        params = urllib.parse.parse_qs(query, keep_blank_values=False)
        urls = params.get("url", [])
        if len(urls) != 1:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Missing url"})
            return
        target = urllib.parse.urlparse(urls[0])
        if target.scheme not in ("http", "https") or target.hostname not in ALLOWED_HOSTS:
            self._send_json(HTTPStatus.FORBIDDEN, {"error": "Host not allowed"})
            return
        full = urllib.parse.urlunparse(target)
        try:
            req = urllib.request.Request(
                full,
                headers={
                    "User-Agent": "Mozilla/5.0 (compatible; StockProject/1.0)",
                    "Accept": "application/json",
                },
                method="GET",
            )
            with urllib.request.urlopen(req, timeout=25) as resp:
                body = resp.read()
                ctype = resp.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as e:
            self._send_bytes(e.code, e.read(), "application/json")
            return
        except urllib.error.URLError as e:
            self._send_json(HTTPStatus.BAD_GATEWAY, {"error": str(e.reason)})
            return
        self._send_bytes(HTTPStatus.OK, body, ctype.split(";")[0].strip() or "application/json")

    def _send_json(self, status: HTTPStatus | int, payload: object) -> None:
        data = json.dumps(payload).encode("utf-8")
        self._send_bytes(status, data, "application/json")

    def _send_bytes(self, status: HTTPStatus | int, data: bytes, content_type: str) -> None:
        code = int(status)
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt: str, *args: object) -> None:
        pass


def main() -> None:
    root = Path(__file__).resolve().parent
    os.chdir(root)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Serving {root} at http://localhost:{PORT}/ or http://<your-machine-ip>:{PORT}/\nPress Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
