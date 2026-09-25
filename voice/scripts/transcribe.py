#!/usr/bin/env python
"""Transcribe free-talk takes (data/free/*.wav) with Whisper on Apple Silicon (mlx-whisper),
split them into 2-14 s clips at sentence boundaries, and add them to data/raw/manifest.jsonl.

Free speech adds natural prosody the read prompts don't have. Check the transcripts it prints:
a wrong word in a transcript teaches the model to mispronounce.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
FREE = ROOT / "data" / "free"
RAW = ROOT / "data" / "raw"
MANIFEST = RAW / "manifest.jsonl"

WHISPER = "mlx-community/whisper-large-v3-turbo"
TARGET_S, MAX_S, MIN_S = 9.0, 14.0, 2.0
PAD_S = 0.15


def already_done() -> set[str]:
    takes = set()
    if MANIFEST.exists():
        for line in MANIFEST.read_text().splitlines():
            if line.strip():
                row = json.loads(line)
                if row.get("source") == "free":
                    takes.add(row["take"])
    return takes


def merge_segments(segments: list[dict]) -> list[dict]:
    """Merge Whisper segments into clips of ~TARGET_S, never exceeding MAX_S, cutting at pauses."""
    clips: list[dict] = []
    cur: dict | None = None
    for s in segments:
        if s.get("no_speech_prob", 0) > 0.5 or s.get("avg_logprob", 0) < -1.0:
            if cur:
                clips.append(cur)
                cur = None
            continue
        text = s["text"].strip()
        if not text:
            continue
        if cur is None:
            cur = {"start": s["start"], "end": s["end"], "text": text}
            continue
        gap = s["start"] - cur["end"]
        merged_len = s["end"] - cur["start"]
        ends_sentence = bool(re.search(r"[.!?]$", cur["text"]))
        if merged_len <= MAX_S and not (ends_sentence and (cur["end"] - cur["start"]) >= TARGET_S) and gap < 0.8:
            cur["end"] = s["end"]
            cur["text"] += " " + text
        else:
            clips.append(cur)
            cur = {"start": s["start"], "end": s["end"], "text": text}
    if cur:
        clips.append(cur)
    return [c for c in clips if MIN_S <= (c["end"] - c["start"]) <= MAX_S]


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--model", default=WHISPER)
    p.add_argument("--redo", action="store_true", help="re-split takes that were already processed")
    args = p.parse_args()

    import mlx_whisper  # imported late: slow import, and not needed for --help

    takes = sorted(FREE.glob("take_*.wav"))
    if not takes:
        print("No takes in data/free/. Record one with: make record-free")
        return
    done = already_done()
    RAW.mkdir(parents=True, exist_ok=True)
    total = 0.0
    for take in takes:
        if take.name in done and not args.redo:
            print(f"skip {take.name} (already split; use --redo to redo)")
            continue
        print(f"transcribing {take.name} …")
        result = mlx_whisper.transcribe(str(take), path_or_hf_repo=args.model, language="en", condition_on_previous_text=False)
        clips = merge_segments(result["segments"])
        audio, rate = sf.read(take, dtype="float32", always_2d=True)
        audio = audio[:, 0]
        with MANIFEST.open("a") as mf:
            for i, c in enumerate(clips):
                a = max(0, int((c["start"] - PAD_S) * rate))
                b = min(len(audio), int((c["end"] + PAD_S) * rate))
                clip = audio[a:b]
                fname = f"f{take.stem.split('_')[1]}_{i:03d}.wav"
                sf.write(RAW / fname, clip, rate, subtype="PCM_16")
                dur = len(clip) / rate
                total += dur
                mf.write(json.dumps({
                    "id": None, "source": "free", "take": take.name, "file": fname, "text": c["text"],
                    "duration_s": round(dur, 2), "sample_rate": rate, "peak": round(float(np.max(np.abs(clip))), 3),
                }, ensure_ascii=False) + "\n")
                print(f"  {fname} {dur:4.1f}s  {c['text']}")
    print(f"\nadded {total/60:.1f} min of free-speech clips. Fix any wrong transcripts in data/raw/manifest.jsonl, then: make prepare")


if __name__ == "__main__":
    main()
