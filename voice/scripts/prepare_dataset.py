#!/usr/bin/env python
"""CLI wrapper around prepare.py: data/raw -> data/clean, then print stats and a readiness verdict."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from prepare import VAL_FRACTION, describe, prepare  # noqa: E402


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--raw", default=str(ROOT / "data" / "raw"))
    p.add_argument("--out", default=str(ROOT / "data" / "clean"))
    p.add_argument("--val-fraction", type=float, default=VAL_FRACTION)
    args = p.parse_args()
    try:
        stats = prepare(Path(args.raw), Path(args.out), args.val_fraction)
    except (FileNotFoundError, RuntimeError) as e:
        raise SystemExit(str(e))
    print("\n" + describe(stats))
    print(f"\nwrote {Path(args.out) / 'manifest.jsonl'}. Next: make upload && make all")


if __name__ == "__main__":
    main()
