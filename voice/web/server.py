#!/usr/bin/env python
"""Local backend for the browser voice recorder (web/index.html).

Owns prompts/sentences.txt (read), RAW_DIR/p{idx:04d}.wav, RAW_DIR/manifest.jsonl and
RAW_DIR/skipped.json in the exact layout scripts/record.py writes and scripts/prepare_dataset.py reads.
Stdlib only. Run: uv run python web/server.py  (env PORT, RAW_DIR override the defaults).
"""
from __future__ import annotations

import array
import io
import json
import os
import re
import signal
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
PROMPTS = ROOT / "prompts" / "sentences.txt"
RAW = Path(os.environ.get("RAW_DIR") or ROOT / "data" / "raw").resolve()
MANIFEST = RAW / "manifest.jsonl"
SKIPPED = RAW / "skipped.json"
HOST = "127.0.0.1"
PORT = int(os.environ.get("PORT") or 4300)
RATE = 48000
MAX_BODY = 64 * 1024 * 1024

TAKE_RE = re.compile(r"^/api/take/(\d+)(\.wav)?$")
SKIP_RE = re.compile(r"^/api/skip/(\d+)$")

LOCK = threading.Lock()


class BadRequest(Exception):
    pass


def load_prompts() -> list[str]:
    lines = [l.strip() for l in PROMPTS.read_text().splitlines()]
    return [l for l in lines if l and not l.startswith("#")]


def read_manifest() -> list[dict]:
    if not MANIFEST.exists():
        return []
    rows = []
    for n, line in enumerate(MANIFEST.read_text().splitlines(), 1):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as e:
            print(f"manifest.jsonl line {n} skipped ({e.msg}): {line[:60]!r}", flush=True)
    return rows


def write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".tmp.{os.getpid()}.{threading.get_ident()}")
    tmp.write_text(text)
    os.replace(tmp, path)


def write_manifest(rows: list[dict]) -> None:
    write_atomic(MANIFEST, "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))


def read_skipped() -> list[int]:
    if not SKIPPED.exists():
        return []
    try:
        data = json.loads(SKIPPED.read_text() or "[]")
    except json.JSONDecodeError:
        return []
    return sorted({int(i) for i in data}) if isinstance(data, list) else []


def write_skipped(idxs: list[int]) -> None:
    write_atomic(SKIPPED, json.dumps(sorted(set(idxs))) + "\n")


def kept_takes(rows: list[dict]) -> dict[str, dict]:
    by_file: dict[str, dict] = {}
    for r in rows:
        if r.get("source", "prompt") == "prompt" and "file" in r:
            by_file[r["file"]] = r
    takes: dict[str, dict] = {}
    for r in by_file.values():
        idx = r.get("id")
        if idx is None:
            m = re.match(r"^p(\d+)\.wav$", r["file"])
            if not m:
                continue
            idx = int(m.group(1))
        takes[str(idx)] = {
            "file": r["file"],
            "duration_s": r.get("duration_s", 0.0),
            "peak": r.get("peak", 0.0),
            "recorded_at": r.get("recorded_at"),
            "mismatch": r.get("mismatch", 0),
        }
    return takes


def totals(rows: list[dict]) -> dict:
    takes = kept_takes(rows)
    return {
        "total_seconds": round(sum(float(t["duration_s"] or 0) for t in takes.values()), 2),
        "count": len(takes),
    }


def fname(idx: int) -> str:
    return f"p{idx:04d}.wav"


def analyze_wav(data: bytes) -> tuple[float, float]:
    if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise BadRequest("not a RIFF/WAVE file: send the encoded WAV bytes with Content-Type audio/wav")
    try:
        with wave.open(io.BytesIO(data)) as w:
            ch, width, rate, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
            if ch != 1:
                raise BadRequest(f"{ch} channels: encode mono (1 channel)")
            if rate != RATE:
                raise BadRequest(f"sample rate {rate} Hz: resample to {RATE} Hz before encoding")
            if width != 2:
                raise BadRequest(f"{width * 8}-bit samples: encode 16-bit PCM")
            frames = w.readframes(n)
    except wave.Error as e:
        raise BadRequest(f"unreadable WAV ({e}): encode 16-bit PCM mono {RATE} Hz")
    if not frames:
        raise BadRequest("WAV has no samples: record something before keeping")
    samples = array.array("h")
    samples.frombytes(frames[: len(frames) - len(frames) % 2])
    if sys.byteorder == "big":
        samples.byteswap()
    peak = max(-min(samples), max(samples)) / 32768.0
    duration = len(samples) / RATE
    return duration, min(peak, 1.0)


def json_bytes(obj) -> bytes:
    return (json.dumps(obj, ensure_ascii=False) + "\n").encode()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "voice-web/1"
    prompts: list[str] = []

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

    def parse_idx(self, s: str) -> int:
        idx = int(s)
        if idx >= len(self.prompts):
            raise BadRequest(f"prompt index {idx} out of range: valid 0..{len(self.prompts) - 1}")
        return idx

    def do_GET(self):
        path = urlsplit(self.path).path
        try:
            if path in ("/", "/index.html"):
                page = WEB / "index.html"
                if page.exists():
                    self.send_bytes(200, page.read_bytes(), "text/html; charset=utf-8")
                else:
                    self.send_bytes(200, b"index.html not built yet\n", "text/plain; charset=utf-8")
                return
            if path == "/api/state":
                with LOCK:
                    rows = read_manifest()
                    skipped = read_skipped()
                self.send_json(200, {
                    "prompts": self.prompts,
                    "takes": kept_takes(rows),
                    "skipped": skipped,
                    **totals(rows),
                    "raw_dir": self.raw_dir_label(),
                })
                return
            m = TAKE_RE.match(path)
            if m and m.group(2):
                idx = self.parse_idx(m.group(1))
                wav = RAW / fname(idx)
                if not wav.exists():
                    self.send_error_json(404, f"no take for prompt {idx}: record it first")
                    return
                self.send_bytes(200, wav.read_bytes(), "audio/wav")
                return
            self.send_error_json(404, f"unknown path {path}: see /api/state")
        except BadRequest as e:
            self.send_error_json(400, str(e))
        except Exception as e:
            self.send_error_json(500, f"{type(e).__name__}: {e}")

    do_HEAD = do_GET

    def do_POST(self):
        parts = urlsplit(self.path)
        path, query = parts.path, parse_qs(parts.query, keep_blank_values=True)
        try:
            body = self.read_body()
            m = TAKE_RE.match(path)
            if m and not m.group(2):
                self.post_take(self.parse_idx(m.group(1)), body, query)
                return
            m = SKIP_RE.match(path)
            if m:
                self.post_skip(self.parse_idx(m.group(1)), body)
                return
            self.send_error_json(404, f"unknown path {path}: POST /api/take/{{idx}} or /api/skip/{{idx}}")
        except BadRequest as e:
            self.send_error_json(400, str(e))
        except Exception as e:
            self.send_error_json(500, f"{type(e).__name__}: {e}")

    def do_DELETE(self):
        path = urlsplit(self.path).path
        try:
            self.read_body()
            m = TAKE_RE.match(path)
            if not m or m.group(2):
                self.send_error_json(404, f"unknown path {path}: DELETE /api/take/{{idx}}")
                return
            idx = self.parse_idx(m.group(1))
            f = fname(idx)
            with LOCK:
                rows = [r for r in read_manifest() if r.get("file") != f]
                write_manifest(rows)
                wav = RAW / f
                if wav.exists():
                    wav.unlink()
            self.send_json(200, totals(rows))
        except BadRequest as e:
            self.send_error_json(400, str(e))
        except Exception as e:
            self.send_error_json(500, f"{type(e).__name__}: {e}")

    def post_take(self, idx: int, body: bytes, query: dict) -> None:
        if not body:
            raise BadRequest("empty body: send the WAV bytes as the request body")
        duration, peak = analyze_wav(body)
        asr = query.get("asr", [None])[0]
        try:
            mismatch = int(query.get("mismatch", ["0"])[0] or 0)
        except ValueError:
            raise BadRequest("mismatch must be an integer: pass ?mismatch=<n>")
        f = fname(idx)
        row = {
            "id": idx,
            "source": "prompt",
            "file": f,
            "text": self.prompts[idx],
            "duration_s": round(duration, 2),
            "sample_rate": RATE,
            "peak": round(peak, 3),
            "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "asr": asr if asr else None,
            "mismatch": mismatch,
        }
        with LOCK:
            RAW.mkdir(parents=True, exist_ok=True)
            tmp = RAW / (f + ".tmp")
            tmp.write_bytes(body)
            os.replace(tmp, RAW / f)
            rows = [r for r in read_manifest() if r.get("file") != f]
            rows.append(row)
            write_manifest(rows)
        self.send_json(200, {**row, **totals(rows)})

    def post_skip(self, idx: int, body: bytes) -> None:
        try:
            data = json.loads(body or b"{}")
        except json.JSONDecodeError:
            raise BadRequest('body is not JSON: send {"skipped": true|false}')
        if not isinstance(data, dict) or not isinstance(data.get("skipped"), bool):
            raise BadRequest('missing boolean "skipped": send {"skipped": true|false}')
        with LOCK:
            skipped = set(read_skipped())
            (skipped.add if data["skipped"] else skipped.discard)(idx)
            skipped_list = sorted(skipped)
            write_skipped(skipped_list)
        self.send_json(200, {"skipped": skipped_list})

    def raw_dir_label(self) -> str:
        try:
            return str(RAW.relative_to(ROOT))
        except ValueError:
            return str(RAW)


def main() -> None:
    if not PROMPTS.exists():
        sys.exit(f"{PROMPTS} not found")
    signal.signal(signal.SIGINT, signal.default_int_handler)
    Handler.prompts = load_prompts()
    RAW.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    rows = read_manifest()
    t = totals(rows)
    print(f"voice recorder  http://{HOST}:{PORT}  prompts={len(Handler.prompts)}  "
          f"kept={t['count']} ({t['total_seconds'] / 60:.1f} min)  raw={RAW}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
