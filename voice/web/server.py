#!/usr/bin/env python
"""The voice recorder server. Stdlib only, plus ffmpeg for the dataset export.

Two modes, picked by VOICE_DATA_DIR:
  local  (unset)   one voice: `/` is the recorder, takes go to RAW_DIR (data/raw). `make web`.
  hosted (set)     many voices: `/` is the landing page, each voice lives at /v/<slug>/ and stores under
                   VOICE_DATA_DIR/<slug>/raw. This is what runs on Railway (Dockerfile in ../).

Routes (hosted; the local mode has the same /api/* without the /v/<slug> prefix):
  GET  /                         landing page (web/landing.html)
  POST /api/new                  -> {slug, url}; the link is the only key to a voice
  GET  /api/info                 min/target minutes, contact, repo
  GET  /finetune.py              the training script, so `curl -O` works from any GPU box
  GET  /v/<slug>/                the recorder (web/index.html)
  GET  /v/<slug>/train           download + training steps (web/train.html)
  GET  /v/<slug>/api/state       prompts, kept takes, skipped, totals  (+ studio flags)
  POST /v/<slug>/api/take/<i>    WAV body (48 kHz mono 16-bit) ?asr=&mismatch=
  GET  /v/<slug>/api/take/<i>.wav
  DELETE /v/<slug>/api/take/<i>
  POST /v/<slug>/api/skip/<i>    {"skipped": bool}
  GET  /v/<slug>/api/job         {count, minutes, ready, ...}
  GET  /v/<slug>/dataset.zip     runs prepare.py (ffmpeg -> 24 kHz clean clips) and zips clean/ + manifest + README

Env: PORT (4300), HOST (127.0.0.1 locally, 0.0.0.0 when PORT is set by the platform), RAW_DIR, VOICE_DATA_DIR,
     VOICE_MIN_MINUTES (10), VOICE_TARGET_MINUTES (30), VOICE_CONTACT, VOICE_REPO.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import signal
import sys
import tempfile
import threading
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from takes import BadRequest, Store, load_prompts  # noqa: E402

WEB = ROOT / "web"
PROMPTS = ROOT / "prompts" / "sentences.txt"
RAW = Path(os.environ.get("RAW_DIR") or ROOT / "data" / "raw").resolve()
DATA_DIR = Path(os.environ["VOICE_DATA_DIR"]).resolve() if os.environ.get("VOICE_DATA_DIR") else None
HOSTED = DATA_DIR is not None
PORT = int(os.environ.get("PORT") or 4300)
HOST = os.environ.get("HOST") or ("0.0.0.0" if os.environ.get("PORT") else "127.0.0.1")
MAX_BODY = 64 * 1024 * 1024
INFO = {
    "min_minutes": float(os.environ.get("VOICE_MIN_MINUTES", "10")),
    "target_minutes": float(os.environ.get("VOICE_TARGET_MINUTES", "30")),
    "contact": os.environ.get("VOICE_CONTACT", ""),
    "repo": os.environ.get("VOICE_REPO", "https://github.com/Pran-Ker/engram/tree/main/voice"),
}

SLUG_RE = re.compile(r"^[a-z0-9]{6,16}$")
VOICE_RE = re.compile(r"^/v/([a-z0-9]{6,16})(/.*)?$")
TAKE_RE = re.compile(r"^/api/take/(\d+)(\.wav)?$")
SKIP_RE = re.compile(r"^/api/skip/(\d+)$")


def json_bytes(obj) -> bytes:
    return (json.dumps(obj, ensure_ascii=False) + "\n").encode()


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


class Voices:
    """Stores per slug, created lazily. Hosted mode only."""

    def __init__(self, root: Path, prompts: list[str]) -> None:
        self.root, self.prompts = root, prompts
        self.stores: dict[str, Store] = {}
        self.lock = threading.Lock()

    def exists(self, slug: str) -> bool:
        return bool(SLUG_RE.match(slug)) and (self.root / slug / "voice.json").exists()

    def new(self) -> str:
        with self.lock:
            slug = secrets.token_hex(4)
            while (self.root / slug).exists():
                slug = secrets.token_hex(4)
            (self.root / slug / "raw").mkdir(parents=True)
            (self.root / slug / "voice.json").write_text(json.dumps({"slug": slug, "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}))
        return slug

    def store(self, slug: str) -> Store:
        with self.lock:
            if slug not in self.stores:
                self.stores[slug] = Store(self.root / slug / "raw", self.prompts)
            return self.stores[slug]

    def dataset_zip(self, slug: str) -> Path:
        """prepare.py on the raw takes (cached by manifest signature), then one zip next to it."""
        from prepare import describe, prepare

        d = self.root / slug
        store = self.store(slug)
        manifest = store.manifest
        if not manifest.exists() or store.totals(store.read_manifest())["count"] == 0:
            raise BadRequest("nothing recorded yet")
        sig = f"{manifest.stat().st_mtime_ns}:{manifest.stat().st_size}"
        stamp = d / "clean.sig"
        zpath = d / f"voice-{slug}.zip"
        with store.lock:
            if not (stamp.exists() and stamp.read_text() == sig and zpath.exists()):
                stats = prepare(d / "raw", d / "clean")
                readme = (
                    f"voice-{slug}: {stats['clips']} clips, {stats['minutes']} min, 24 kHz mono 16-bit, 1-14 s each.\n"
                    f"{describe(stats)}\n\n"
                    "Train (any CUDA machine, ~40 GB GPU memory at batch 16, or --batch 4 on 24 GB):\n"
                    '  pip install "liquid-audio==1.3.0" soundfile\n'
                    f'  python finetune.py train --data voice-{slug} --name "Your Name"\n'
                    '  python finetune.py say --ckpt "ckpt/Your Name/final" --text "Hello."\n'
                    f"finetune.py: {INFO['repo']}\n"
                )
                tmp = zpath.with_suffix(".tmp")
                with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
                    z.writestr(f"voice-{slug}/README.txt", readme)
                    for f in sorted((d / "clean").iterdir()):
                        z.write(f, f"voice-{slug}/clean/{f.name}")
                    fin = ROOT / "finetune.py"
                    if fin.exists():
                        z.write(fin, f"voice-{slug}/finetune.py")
                os.replace(tmp, zpath)
                stamp.write_text(sig)
        return zpath


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "voice-web/3"
    local_store: Store | None = None
    voices: Voices | None = None

    def log_request(self, code="-", size="-"):
        print(f"{time.strftime('%H:%M:%S')} {self.command} {self.path} {code}", flush=True)

    def log_error(self, format, *args):
        pass

    # ---- responses
    def send_bytes(self, code: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_file(self, path: Path, ctype: str, download: str | None = None) -> None:
        size = path.stat().st_size
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-store")
        if download:
            self.send_header("Content-Disposition", f'attachment; filename="{download}"')
        self.end_headers()
        if self.command == "HEAD":
            return
        with path.open("rb") as f:
            shutil.copyfileobj(f, self.wfile)

    def send_json(self, code: int, obj) -> None:
        self.send_bytes(code, json_bytes(obj), "application/json; charset=utf-8")

    def send_error_json(self, code: int, msg: str) -> None:
        self.send_json(code, {"error": msg})

    def send_page(self, name: str) -> None:
        page = WEB / name
        if page.exists():
            self.send_bytes(200, page.read_bytes(), "text/html; charset=utf-8")
        else:
            self.send_bytes(200, f"{name} not built yet\n".encode(), "text/plain; charset=utf-8")

    def redirect(self, to: str) -> None:
        self.send_response(307)
        self.send_header("Location", to)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def read_body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise BadRequest(f"body {n} bytes exceeds {MAX_BODY}: a 14 s take is ~1.4 MB")
        return self.rfile.read(n) if n else b""

    # ---- routing
    def resolve(self, path: str) -> tuple[Store | None, str | None, str]:
        """-> (store, slug, path relative to the voice). Local mode: the one store at the root."""
        if not HOSTED:
            return self.local_store, None, path
        m = VOICE_RE.match(path)
        if not m:
            return None, None, path
        slug, rest = m.group(1), m.group(2) or ""
        if not self.voices.exists(slug):
            raise BadRequest(f"no voice {slug!r}: start one at /", 404)
        return self.voices.store(slug), slug, rest

    def flags(self, slug: str | None) -> dict:
        return {"studio": HOSTED, **INFO} if HOSTED else {}

    def job(self, store: Store, slug: str | None) -> dict:
        t = store.totals(store.read_manifest())
        minutes = round(t["total_seconds"] / 60, 2)
        return {"count": t["count"], "minutes": minutes, "ready": minutes >= INFO["min_minutes"], "slug": slug, **INFO}

    def handle_errors(fn):
        def wrapped(self):
            try:
                fn(self)
            except BadRequest as e:
                code = e.args[1] if len(e.args) > 1 else 400
                self.send_error_json(code, str(e.args[0]))
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as e:
                self.send_error_json(500, f"{type(e).__name__}: {e}")
        return wrapped

    @handle_errors
    def do_GET(self):
        path = urlsplit(self.path).path
        if HOSTED:
            if path in ("/", "/index.html"):
                self.send_page("landing.html"); return
            if path == "/api/info":
                self.send_json(200, INFO); return
            if path == "/finetune.py":
                self.send_file(ROOT / "finetune.py", "text/x-python; charset=utf-8", "finetune.py"); return
            if path == "/health":
                n = sum(1 for q in DATA_DIR.iterdir() if (q / "voice.json").exists())
                self.send_json(200, {"ok": True, "hosted": True, "voices": n, "data_dir": str(DATA_DIR),
                                     "persistent": os.path.ismount(DATA_DIR), **INFO}); return
        store, slug, rest = self.resolve(path)
        if store is None:
            self.send_error_json(404, f"unknown path {path}"); return
        if HOSTED and rest == "":
            self.redirect(f"/v/{slug}/"); return
        if rest in ("/", "/index.html"):
            self.send_page("index.html"); return
        if rest == "/train":
            self.send_page("train.html"); return
        if rest == "/api/state":
            self.send_json(200, {**store.state(), **self.flags(slug), "raw_dir": self.raw_dir_label(store)}); return
        if rest == "/api/job":
            self.send_json(200, self.job(store, slug)); return
        if rest == "/dataset.zip":
            z = self.voices.dataset_zip(slug)
            self.send_file(z, "application/zip", z.name); return
        m = TAKE_RE.match(rest)
        if m and m.group(2):
            wav = store.take_bytes(int(m.group(1)))
            if wav is None:
                self.send_error_json(404, f"no take for prompt {m.group(1)}: record it first")
            else:
                self.send_bytes(200, wav, "audio/wav")
            return
        self.send_error_json(404, f"unknown path {path}: see {'/v/<slug>' if HOSTED else ''}/api/state")

    do_HEAD = do_GET

    @handle_errors
    def do_POST(self):
        parts = urlsplit(self.path)
        path, query = parts.path, parse_qs(parts.query, keep_blank_values=True)
        body = self.read_body()
        if HOSTED and path == "/api/new":
            slug = self.voices.new()
            self.send_json(200, {"slug": slug, "url": f"/v/{slug}/"}); return
        store, slug, rest = self.resolve(path)
        if store is None:
            self.send_error_json(404, f"unknown path {path}"); return
        m = TAKE_RE.match(rest)
        if m and not m.group(2):
            asr = query.get("asr", [None])[0]
            try:
                mismatch = int(query.get("mismatch", ["0"])[0] or 0)
            except ValueError:
                raise BadRequest("mismatch must be an integer: pass ?mismatch=<n>")
            self.send_json(200, store.put_take(int(m.group(1)), body, asr, mismatch)); return
        m = SKIP_RE.match(rest)
        if m:
            try:
                data = json.loads(body or b"{}")
            except json.JSONDecodeError:
                raise BadRequest('body is not JSON: send {"skipped": true|false}')
            if not isinstance(data, dict) or not isinstance(data.get("skipped"), bool):
                raise BadRequest('missing boolean "skipped": send {"skipped": true|false}')
            self.send_json(200, {"skipped": store.set_skipped(int(m.group(1)), data["skipped"])}); return
        self.send_error_json(404, f"unknown path {path}: POST .../api/take/{{idx}} or .../api/skip/{{idx}}")

    @handle_errors
    def do_DELETE(self):
        path = urlsplit(self.path).path
        self.read_body()
        store, slug, rest = self.resolve(path)
        m = TAKE_RE.match(rest) if store else None
        if not m or m.group(2):
            self.send_error_json(404, f"unknown path {path}: DELETE .../api/take/{{idx}}"); return
        self.send_json(200, store.delete_take(int(m.group(1))))

    def raw_dir_label(self, store: Store) -> str:
        try:
            return str(store.raw.relative_to(ROOT))
        except ValueError:
            return str(store.raw)


def main() -> None:
    if not PROMPTS.exists():
        sys.exit(f"{PROMPTS} not found")
    if HOSTED and shutil.which("ffmpeg") is None:
        print("warning: ffmpeg not found; dataset export will fail", flush=True)
    signal.signal(signal.SIGINT, signal.default_int_handler)
    signal.signal(signal.SIGTERM, lambda *_: os._exit(0))  # Railway sends SIGTERM on redeploy; exit at once
    prompts = load_prompts(PROMPTS)
    if HOSTED:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        Handler.voices = Voices(DATA_DIR, prompts)
        n = sum(1 for p in DATA_DIR.iterdir() if (p / "voice.json").exists())
        print(f"voice studio  http://{HOST}:{PORT}  prompts={len(prompts)}  voices={n}  data={DATA_DIR}", flush=True)
    else:
        RAW.mkdir(parents=True, exist_ok=True)
        Handler.local_store = Store(RAW, prompts)
        t = Handler.local_store.state()
        print(f"voice recorder  http://{HOST}:{PORT}  prompts={len(prompts)}  "
              f"kept={t['count']} ({t['total_seconds'] / 60:.1f} min)  raw={RAW}", flush=True)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
