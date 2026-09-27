#!/usr/bin/env python
"""Local backend for the browser voice recorder (web/index.html).

Serves prompts/sentences.txt and stores takes in RAW_DIR via takes.Store (p####.wav, manifest.jsonl, skipped.json),
the exact layout scripts/record.py writes and prepare.py reads. Stdlib only.
Run: uv run python web/server.py  (env PORT, RAW_DIR override the defaults).
For the hosted version of the same recorder plus training, see ../studio.py.
"""
from __future__ import annotations

import json
import os
import re
import signal
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from takes import BadRequest, Store, load_prompts  # noqa: E402

WEB = ROOT / "web"
PROMPTS = ROOT / "prompts" / "sentences.txt"
RAW = Path(os.environ.get("RAW_DIR") or ROOT / "data" / "raw").resolve()
HOST = "127.0.0.1"
PORT = int(os.environ.get("PORT") or 4300)
MAX_BODY = 64 * 1024 * 1024

TAKE_RE = re.compile(r"^/api/take/(\d+)(\.wav)?$")
SKIP_RE = re.compile(r"^/api/skip/(\d+)$")


def json_bytes(obj) -> bytes:
    return (json.dumps(obj, ensure_ascii=False) + "\n").encode()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "voice-web/2"
    store: Store

    def log_request(self, code="-", size="-"):
        print(f"{time.strftime('%H:%M:%S')} {self.command} {self.path} {code}", flush=True)

    def log_error(self, format, *args):
        pass

    def send_bytes(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, code: int, obj) -> None:
        self.send_bytes(code, json_bytes(obj), "application/json; charset=utf-8")

    def send_error_json(self, code: int, msg: str) -> None:
        self.send_json(code, {"error": msg})

    def read_body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise BadRequest(f"body {n} bytes exceeds {MAX_BODY}: a 14 s take is ~1.4 MB")
        return self.rfile.read(n) if n else b""

    def handle_errors(fn):
        def wrapped(self):
            try:
                fn(self)
            except BadRequest as e:
                self.send_error_json(400, str(e))
            except Exception as e:
                self.send_error_json(500, f"{type(e).__name__}: {e}")
        return wrapped

    @handle_errors
    def do_GET(self):
        path = urlsplit(self.path).path
        if path in ("/", "/index.html"):
            page = WEB / "index.html"
            body = page.read_bytes() if page.exists() else b"index.html not built yet\n"
            self.send_bytes(200, body, "text/html; charset=utf-8" if page.exists() else "text/plain; charset=utf-8")
            return
        if path == "/api/state":
            self.send_json(200, {**self.store.state(), "raw_dir": self.raw_dir_label()})
            return
        m = TAKE_RE.match(path)
        if m and m.group(2):
            wav = self.store.take_bytes(int(m.group(1)))
            if wav is None:
                self.send_error_json(404, f"no take for prompt {m.group(1)}: record it first")
            else:
                self.send_bytes(200, wav, "audio/wav")
            return
        self.send_error_json(404, f"unknown path {path}: see /api/state")

    do_HEAD = do_GET

    @handle_errors
    def do_POST(self):
        parts = urlsplit(self.path)
        path, query = parts.path, parse_qs(parts.query, keep_blank_values=True)
        body = self.read_body()
        m = TAKE_RE.match(path)
        if m and not m.group(2):
            asr = query.get("asr", [None])[0]
            try:
                mismatch = int(query.get("mismatch", ["0"])[0] or 0)
            except ValueError:
                raise BadRequest("mismatch must be an integer: pass ?mismatch=<n>")
            self.send_json(200, self.store.put_take(int(m.group(1)), body, asr, mismatch))
            return
        m = SKIP_RE.match(path)
        if m:
            try:
                data = json.loads(body or b"{}")
            except json.JSONDecodeError:
                raise BadRequest('body is not JSON: send {"skipped": true|false}')
            if not isinstance(data, dict) or not isinstance(data.get("skipped"), bool):
                raise BadRequest('missing boolean "skipped": send {"skipped": true|false}')
            self.send_json(200, {"skipped": self.store.set_skipped(int(m.group(1)), data["skipped"])})
            return
        self.send_error_json(404, f"unknown path {path}: POST /api/take/{{idx}} or /api/skip/{{idx}}")

    @handle_errors
    def do_DELETE(self):
        path = urlsplit(self.path).path
        self.read_body()
        m = TAKE_RE.match(path)
        if not m or m.group(2):
            self.send_error_json(404, f"unknown path {path}: DELETE /api/take/{{idx}}")
            return
        self.send_json(200, self.store.delete_take(int(m.group(1))))

    def raw_dir_label(self) -> str:
        try:
            return str(RAW.relative_to(ROOT))
        except ValueError:
            return str(RAW)


def main() -> None:
    if not PROMPTS.exists():
        sys.exit(f"{PROMPTS} not found")
    signal.signal(signal.SIGINT, signal.default_int_handler)
    RAW.mkdir(parents=True, exist_ok=True)
    Handler.store = Store(RAW, load_prompts(PROMPTS))
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    t = Handler.store.state()
    print(f"voice recorder  http://{HOST}:{PORT}  prompts={len(Handler.store.prompts)}  "
          f"kept={t['count']} ({t['total_seconds'] / 60:.1f} min)  raw={RAW}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
