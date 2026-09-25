#!/usr/bin/env python
"""Guided voice recording for the LFM2.5-Audio fine-tune.

Two modes:
  default  -> reads prompts/sentences.txt, records one sentence at a time into data/raw/
  --free   -> records one long free-talk take into data/free/ (split later by transcribe.py)

Recordings are 48 kHz mono 16-bit WAV. prepare_dataset.py trims, normalizes and resamples to 24 kHz.
The manifest (data/raw/manifest.jsonl) makes the session resumable: already-recorded prompts are skipped.
"""
from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from pathlib import Path

import numpy as np
import sounddevice as sd
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
PROMPTS = ROOT / "prompts" / "sentences.txt"
RAW = ROOT / "data" / "raw"
FREE = ROOT / "data" / "free"
MANIFEST = RAW / "manifest.jsonl"

MIN_SECONDS = 1.0
MAX_SECONDS = 14.0       # ~175 Mimi frames; keeps every sample under the training context length
QUIET_PEAK = 0.05        # below this the mic gain is too low
CLIP_PEAK = 0.99


def load_prompts(path: Path) -> list[str]:
    lines = [l.strip() for l in path.read_text().splitlines()]
    return [l for l in lines if l and not l.startswith("#")]


def load_manifest() -> dict[int, dict]:
    done: dict[int, dict] = {}
    if MANIFEST.exists():
        for line in MANIFEST.read_text().splitlines():
            if line.strip():
                row = json.loads(line)
                if row.get("source") == "prompt":
                    done[row["id"]] = row
    return done


def append_manifest(row: dict) -> None:
    with MANIFEST.open("a") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def resolve_device(spec: str | None) -> int | None:
    """Turn an index or a name substring into a valid input-device index; fall back to the default input."""
    devices = sd.query_devices()
    inputs = [(i, d) for i, d in enumerate(devices) if d["max_input_channels"] > 0]
    if spec is not None:
        if spec.isdigit() and int(spec) < len(devices) and devices[int(spec)]["max_input_channels"] > 0:
            chosen = int(spec)
        else:
            matches = [i for i, d in inputs if spec.lower() in d["name"].lower()]
            if not matches:
                print(f"No input device matching {spec!r}. Inputs: " + ", ".join(f"{i}={d['name']}" for i, d in inputs))
                sys.exit(1)
            chosen = matches[0]
    else:
        default_in = sd.default.device[0]
        chosen = default_in if default_in is not None and default_in >= 0 else inputs[0][0]
    print(f"mic: [{chosen}] {devices[chosen]['name']}")
    return chosen


def record_until_enter(rate: int, device: int | None) -> np.ndarray:
    """Record from the mic until the user presses Enter. Returns float32 mono samples."""
    chunks: list[np.ndarray] = []
    stop = threading.Event()

    def callback(indata, frames, time_info, status):  # noqa: ARG001
        if status:
            print(f"  [audio warning] {status}", file=sys.stderr)
        chunks.append(indata[:, 0].copy())

    def wait_for_enter():
        input()
        stop.set()

    t0 = time.monotonic()
    with sd.InputStream(samplerate=rate, channels=1, dtype="float32", device=device, callback=callback):
        threading.Thread(target=wait_for_enter, daemon=True).start()
        while not stop.is_set():
            elapsed = time.monotonic() - t0
            print(f"\r  ● REC {elapsed:5.1f}s  (Enter to stop)", end="", flush=True)
            if elapsed > MAX_SECONDS + 6:  # hard stop so a missed Enter can't run forever
                break
            time.sleep(0.1)
    print()
    return np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)


def check_take(audio: np.ndarray, rate: int) -> list[str]:
    problems = []
    dur = len(audio) / rate
    peak = float(np.max(np.abs(audio))) if len(audio) else 0.0
    if dur < MIN_SECONDS:
        problems.append(f"too short ({dur:.1f}s)")
    if dur > MAX_SECONDS:
        problems.append(f"too long ({dur:.1f}s > {MAX_SECONDS:.0f}s) — speak a little faster or split")
    if peak < QUIET_PEAK:
        problems.append(f"very quiet (peak {peak:.2f}) — move closer / raise input gain")
    if peak >= CLIP_PEAK:
        problems.append("clipping — lower input gain or back off the mic")
    return problems


def save_wav(path: Path, audio: np.ndarray, rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(path, audio, rate, subtype="PCM_16")


def guided(args: argparse.Namespace) -> None:
    prompts = load_prompts(Path(args.prompts))
    done = load_manifest()
    todo = [i for i in range(len(prompts)) if i not in done and i >= args.start]
    total_done_s = sum(r["duration_s"] for r in done.values())
    print(f"{len(prompts)} prompts, {len(done)} already recorded ({total_done_s/60:.1f} min), {len(todo)} to go.")
    print("Tips: quiet room, same mic and distance every session, natural pace, read exactly what is shown.")
    print("Keys: Enter=record  s=skip  q=quit   (after a take: Enter=keep  r=redo  p=play)\n")

    for n, idx in enumerate(todo, 1):
        text = prompts[idx]
        while True:
            print(f"[{n}/{len(todo)}]  #{idx:04d}")
            print(f"  » {text}")
            cmd = input("  Enter=record, s=skip, q=quit > ").strip().lower()
            if cmd == "q":
                print("Stopped. Run again to resume.")
                return
            if cmd == "s":
                break
            audio = record_until_enter(args.rate, args.device)
            problems = check_take(audio, args.rate)
            dur = len(audio) / args.rate
            print(f"  {dur:.1f}s" + (f"  ⚠ {'; '.join(problems)}" if problems else "  ✓"))
            while True:
                k = input("  Enter=keep, r=redo, p=play > ").strip().lower()
                if k == "p":
                    sd.play(audio, args.rate)
                    sd.wait()
                    continue
                break
            if k == "r":
                continue
            if problems and any("too short" in p or "clipping" in p for p in problems):
                print("  Not saving a broken take; redo it.")
                continue
            fname = f"p{idx:04d}.wav"
            save_wav(RAW / fname, audio, args.rate)
            append_manifest({
                "id": idx, "source": "prompt", "file": fname, "text": text,
                "duration_s": round(dur, 2), "sample_rate": args.rate,
                "peak": round(float(np.max(np.abs(audio))), 3), "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            })
            total_done_s += dur
            print(f"  saved → data/raw/{fname}   total recorded: {total_done_s/60:.1f} min\n")
            break
    print(f"All prompts recorded. Total {total_done_s/60:.1f} min. Next: make prepare")


def free_take(args: argparse.Namespace) -> None:
    FREE.mkdir(parents=True, exist_ok=True)
    n = len(list(FREE.glob("take_*.wav"))) + 1
    print("Free-talk take: speak naturally for 3-10 minutes (tell a story, explain a project, rant).")
    print("Pause briefly between sentences; that is where the splitter will cut. Press Enter to start.")
    input()
    global MAX_SECONDS
    MAX_SECONDS = 60 * 30
    audio = record_until_enter(args.rate, args.device)
    dur = len(audio) / args.rate
    path = FREE / f"take_{n:02d}.wav"
    save_wav(path, audio, args.rate)
    print(f"saved {path.relative_to(ROOT)} ({dur/60:.1f} min). Next: make transcribe")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--prompts", default=str(PROMPTS))
    p.add_argument("--start", type=int, default=0, help="first prompt index to record")
    p.add_argument("--rate", type=int, default=48000)
    p.add_argument("--device", default=None, help="input device: index or name substring, e.g. 'MacBook Pro Microphone' (see --list-devices). Default: system default input")
    p.add_argument("--list-devices", action="store_true")
    p.add_argument("--free", action="store_true", help="record one long free-talk take instead of prompts")
    args = p.parse_args()

    if args.list_devices:
        print(sd.query_devices())
        return
    args.device = resolve_device(args.device)
    RAW.mkdir(parents=True, exist_ok=True)
    if args.free:
        free_take(args)
    else:
        guided(args)


if __name__ == "__main__":
    main()
