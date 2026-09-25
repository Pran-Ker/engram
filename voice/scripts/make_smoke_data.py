#!/usr/bin/env python
"""Generate a tiny synthetic dataset (tones, not speech) to exercise the full Modal pipeline cheaply."""
from pathlib import Path
import json
import numpy as np
import soundfile as sf

out = Path(__file__).resolve().parent.parent / "data" / "smoke" / "clean"
out.mkdir(parents=True, exist_ok=True)
rate = 24_000
rows = []
texts = ["Testing one two three.", "The quick brown fox jumps over the lazy dog.", "Hello from the smoke test.",
         "This is a synthetic clip.", "Four score and seven years ago.", "Final validation sample."]
for i, text in enumerate(texts):
    dur = 2.0 + 0.5 * i
    t = np.arange(int(dur * rate)) / rate
    wav = 0.2 * np.sin(2 * np.pi * (220 + 40 * i) * t) * (0.5 + 0.5 * np.sin(2 * np.pi * 3 * t))
    fname = f"s{i:03d}.wav"
    sf.write(out / fname, wav.astype(np.float32), rate, subtype="PCM_16")
    rows.append({"file": fname, "text": text, "duration_s": dur, "source": "smoke", "split": "val" if i >= 4 else "train"})
(out / "manifest.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
print(f"wrote {len(rows)} synthetic clips to {out}")
