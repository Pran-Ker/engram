"""Take storage shared by the local recorder (web/server.py) and the hosted studio (studio.py).

One raw dir holds: p####.wav (48 kHz mono 16-bit), manifest.jsonl (one row per kept take; the last row
for a file wins), skipped.json. scripts/prepare_dataset.py and prepare.py read exactly this layout.
"""
from __future__ import annotations

import array
import io
import json
import os
import re
import sys
import threading
import time
import wave
from pathlib import Path

RATE = 48000


class BadRequest(Exception):
    pass


def load_prompts(path: Path) -> list[str]:
    lines = [l.strip() for l in path.read_text().splitlines()]
    return [l for l in lines if l and not l.startswith("#")]


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
    return len(samples) / RATE, min(peak, 1.0)


def write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".tmp.{os.getpid()}.{threading.get_ident()}")
    tmp.write_text(text)
    os.replace(tmp, path)


class Store:
    """All reads and writes for one raw dir. `after_write` runs after every change (the studio commits the volume)."""

    def __init__(self, raw: Path, prompts: list[str], after_write=None) -> None:
        self.raw = Path(raw)
        self.prompts = prompts
        self.after_write = after_write
        self.lock = threading.Lock()

    @property
    def manifest(self) -> Path:
        return self.raw / "manifest.jsonl"

    @property
    def skipped_path(self) -> Path:
        return self.raw / "skipped.json"

    def check_idx(self, idx: int) -> int:
        if idx < 0 or idx >= len(self.prompts):
            raise BadRequest(f"prompt index {idx} out of range: valid 0..{len(self.prompts) - 1}")
        return idx

    # ---- files
    def read_manifest(self) -> list[dict]:
        if not self.manifest.exists():
            return []
        rows = []
        for n, line in enumerate(self.manifest.read_text().splitlines(), 1):
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as e:
                print(f"manifest.jsonl line {n} skipped ({e.msg}): {line[:60]!r}", flush=True)
        return rows

    def write_manifest(self, rows: list[dict]) -> None:
        write_atomic(self.manifest, "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))

    def read_skipped(self) -> list[int]:
        if not self.skipped_path.exists():
            return []
        try:
            data = json.loads(self.skipped_path.read_text() or "[]")
        except json.JSONDecodeError:
            return []
        return sorted({int(i) for i in data}) if isinstance(data, list) else []

    def write_skipped(self, idxs) -> None:
        write_atomic(self.skipped_path, json.dumps(sorted(set(idxs))) + "\n")

    def _changed(self) -> None:
        if self.after_write:
            self.after_write()

    # ---- derived
    @staticmethod
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

    @classmethod
    def totals(cls, rows: list[dict]) -> dict:
        takes = cls.kept_takes(rows)
        return {"total_seconds": round(sum(float(t["duration_s"] or 0) for t in takes.values()), 2), "count": len(takes)}

    def minutes(self) -> float:
        return self.totals(self.read_manifest())["total_seconds"] / 60

    # ---- operations
    def state(self) -> dict:
        with self.lock:
            rows = self.read_manifest()
            skipped = self.read_skipped()
        return {"prompts": self.prompts, "takes": self.kept_takes(rows), "skipped": skipped, **self.totals(rows)}

    def take_bytes(self, idx: int) -> bytes | None:
        wav = self.raw / fname(self.check_idx(idx))
        return wav.read_bytes() if wav.exists() else None

    def put_take(self, idx: int, body: bytes, asr: str | None, mismatch: int) -> dict:
        self.check_idx(idx)
        if not body:
            raise BadRequest("empty body: send the WAV bytes as the request body")
        duration, peak = analyze_wav(body)
        f = fname(idx)
        row = {
            "id": idx, "source": "prompt", "file": f, "text": self.prompts[idx],
            "duration_s": round(duration, 2), "sample_rate": RATE, "peak": round(peak, 3),
            "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "asr": asr or None, "mismatch": mismatch,
        }
        with self.lock:
            self.raw.mkdir(parents=True, exist_ok=True)
            tmp = self.raw / (f + ".tmp")
            tmp.write_bytes(body)
            os.replace(tmp, self.raw / f)
            rows = [r for r in self.read_manifest() if r.get("file") != f]
            rows.append(row)
            self.write_manifest(rows)
            self._changed()
        return {**row, **self.totals(rows)}

    def delete_take(self, idx: int) -> dict:
        f = fname(self.check_idx(idx))
        with self.lock:
            rows = [r for r in self.read_manifest() if r.get("file") != f]
            self.write_manifest(rows)
            wav = self.raw / f
            if wav.exists():
                wav.unlink()
            self._changed()
        return self.totals(rows)

    def set_skipped(self, idx: int, value: bool) -> list[int]:
        self.check_idx(idx)
        with self.lock:
            skipped = set(self.read_skipped())
            (skipped.add if value else skipped.discard)(idx)
            out = sorted(skipped)
            self.write_skipped(out)
            self._changed()
        return out
