#!/usr/bin/env python
"""Turn raw recordings into the clean training set the Modal job expects.

For every row in data/raw/manifest.jsonl:
  ffmpeg: trim leading/trailing silence, add 150 ms of room on both ends, loudness-normalize,
          resample to 24 kHz mono 16-bit (Mimi's native rate)  ->  data/clean/<file>
Then: drop clips outside 1-14 s, normalize the text, split 5 % into validation,
write data/clean/manifest.jsonl and print dataset stats plus a readiness verdict.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path

import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
CLEAN = ROOT / "data" / "clean"

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
    info = sf.info(dst)
    return info.frames / info.samplerate


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--raw", default=str(RAW))
    p.add_argument("--out", default=str(CLEAN))
    p.add_argument("--val-fraction", type=float, default=VAL_FRACTION)
    args = p.parse_args()
    raw, out = Path(args.raw), Path(args.out)
    manifest = raw / "manifest.jsonl"
    if not manifest.exists():
        raise SystemExit(f"{manifest} not found. Record first: make record")
    if shutil.which("ffmpeg") is None:
        raise SystemExit("ffmpeg not found (brew install ffmpeg)")

    rows = [json.loads(l) for l in manifest.read_text().splitlines() if l.strip()]
    # last entry for a file wins (re-recordings append)
    by_file = {r["file"]: r for r in rows}
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    kept, dropped = [], []
    for fname, r in sorted(by_file.items()):
        src = raw / fname
        if not src.exists():
            dropped.append((fname, "missing wav"))
            continue
        dur = convert(src, out / fname)
        if not (MIN_S <= dur <= MAX_S):
            dropped.append((fname, f"{dur:.1f}s outside {MIN_S}-{MAX_S}s"))
            (out / fname).unlink()
            continue
        text = clean_text(r["text"])
        h = int(hashlib.md5(fname.encode()).hexdigest(), 16) % 1000
        split = "val" if h < args.val_fraction * 1000 else "train"
        kept.append({"file": fname, "text": text, "duration_s": round(dur, 2), "source": r.get("source", "prompt"), "split": split})

    if len(kept) >= 10 and sum(k["split"] == "val" for k in kept) < 3:
        for k in kept[:3]:
            k["split"] = "val"

    with (out / "manifest.jsonl").open("w") as f:
        for k in kept:
            f.write(json.dumps(k, ensure_ascii=False) + "\n")

    total = sum(k["duration_s"] for k in kept)
    n_train = sum(k["split"] == "train" for k in kept)
    n_val = len(kept) - n_train
    by_src = {}
    for k in kept:
        by_src[k["source"]] = by_src.get(k["source"], 0) + k["duration_s"]
    print(f"\nclean clips : {len(kept)}  (train {n_train}, val {n_val})")
    print(f"total audio : {total/60:.1f} min   mean clip {total/max(1,len(kept)):.1f}s")
    for s, d in by_src.items():
        print(f"  {s:7s}: {d/60:.1f} min")
    if dropped:
        print(f"dropped     : {len(dropped)}")
        for fname, why in dropped[:15]:
            print(f"  {fname}: {why}")
    mins = total / 60
    if mins < 20:
        verdict = "too little — aim for 45+ min before training (keep recording)"
    elif mins < 45:
        verdict = "usable for a first run; 45-90 min will sound noticeably closer"
    else:
        verdict = "good — ready to train"
    print(f"verdict     : {verdict}")
    print(f"\nwrote {out/'manifest.jsonl'}. Next: make upload && make all")


if __name__ == "__main__":
    main()
