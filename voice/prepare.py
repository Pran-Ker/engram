"""Turn raw recordings into the clean training set the Modal job expects.

For every row in <raw>/manifest.jsonl:
  ffmpeg: trim leading/trailing silence, add 150 ms of room on both ends, loudness-normalize,
          resample to 24 kHz mono 16-bit (Mimi's native rate)  ->  <out>/<file>
Then: drop clips outside 1-14 s, normalize the text, split 5 % into validation,
write <out>/manifest.jsonl and return the stats.

Used by scripts/prepare_dataset.py on the laptop and by studio.py inside the Modal pipeline.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import wave
from pathlib import Path

MIN_S, MAX_S = 1.0, 14.0
VAL_FRACTION = 0.05
TARGET_RATE = 24_000

FILTER = (
    "silenceremove=start_periods=1:start_threshold=-42dB:start_silence=0.15,"
    "areverse,silenceremove=start_periods=1:start_threshold=-42dB:start_silence=0.15,areverse,"
    "adelay=150,apad=pad_dur=0.15,"
    "loudnorm=I=-20:TP=-1.5:LRA=11"
)


def clean_text(t: str) -> str:
    t = re.sub(r"\s+", " ", t).strip()
    t = t.replace("“", '"').replace("”", '"').replace("’", "'").replace("‘", "'")
    if t and t[-1] not in ".!?\"'":
        t += "."
    return t


def convert(src: Path, dst: Path) -> float:
    dst.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-af", FILTER,
           "-ar", str(TARGET_RATE), "-ac", "1", "-sample_fmt", "s16", str(dst)]
    subprocess.run(cmd, check=True)
    with wave.open(str(dst)) as w:  # stdlib: the hosted image has no soundfile
        return w.getnframes() / w.getframerate()


def verdict_for(minutes: float) -> str:
    if minutes < 20:
        return "too little — aim for 45+ min before training (keep recording)"
    if minutes < 45:
        return "usable for a first run; 45-90 min will sound noticeably closer"
    return "good — ready to train"


def prepare(raw: Path, out: Path, val_fraction: float = VAL_FRACTION) -> dict:
    manifest = raw / "manifest.jsonl"
    if not manifest.exists():
        raise FileNotFoundError(f"{manifest} not found. Record first.")
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg not found (brew install ffmpeg)")

    rows = [json.loads(l) for l in manifest.read_text().splitlines() if l.strip()]
    by_file = {r["file"]: r for r in rows}  # last entry for a file wins (re-recordings append)
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    kept, dropped = [], []
    for fname, r in sorted(by_file.items()):
        src = raw / fname
        if not src.exists():
            dropped.append((fname, "missing wav"))
            continue
        try:
            dur = convert(src, out / fname)
        except subprocess.CalledProcessError as e:
            dropped.append((fname, f"ffmpeg failed ({e.returncode})"))
            (out / fname).unlink(missing_ok=True)
            continue
        if not (MIN_S <= dur <= MAX_S):
            dropped.append((fname, f"{dur:.1f}s outside {MIN_S}-{MAX_S}s"))
            (out / fname).unlink()
            continue
        h = int(hashlib.md5(fname.encode()).hexdigest(), 16) % 1000
        split = "val" if h < val_fraction * 1000 else "train"
        kept.append({"file": fname, "text": clean_text(r["text"]), "duration_s": round(dur, 2),
                     "source": r.get("source", "prompt"), "split": split})

    if len(kept) >= 10 and sum(k["split"] == "val" for k in kept) < 3:
        for k in kept[:3]:
            k["split"] = "val"

    with (out / "manifest.jsonl").open("w") as f:
        for k in kept:
            f.write(json.dumps(k, ensure_ascii=False) + "\n")

    total = sum(k["duration_s"] for k in kept)
    n_train = sum(k["split"] == "train" for k in kept)
    by_src: dict[str, float] = {}
    for k in kept:
        by_src[k["source"]] = by_src.get(k["source"], 0) + k["duration_s"]
    return {
        "clips": len(kept), "train": n_train, "val": len(kept) - n_train,
        "minutes": round(total / 60, 2), "mean_clip_s": round(total / max(1, len(kept)), 1),
        "by_source": {s: round(d / 60, 2) for s, d in by_src.items()},
        "dropped": dropped, "verdict": verdict_for(total / 60),
    }


def describe(stats: dict) -> str:
    lines = [
        f"clean clips : {stats['clips']}  (train {stats['train']}, val {stats['val']})",
        f"total audio : {stats['minutes']:.1f} min   mean clip {stats['mean_clip_s']}s",
    ]
    for s, m in stats["by_source"].items():
        lines.append(f"  {s:7s}: {m:.1f} min")
    if stats["dropped"]:
        lines.append(f"dropped     : {len(stats['dropped'])}")
        lines += [f"  {f}: {why}" for f, why in stats["dropped"][:15]]
    lines.append(f"verdict     : {stats['verdict']}")
    return "\n".join(lines)
