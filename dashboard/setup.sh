#!/usr/bin/env bash
# One-time setup for the dashboard: Python deps, ffmpeg + ImageMagick, .env. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"

need() { command -v "$1" >/dev/null 2>&1; }

python3 - <<'PY'
import sys; v = sys.version_info
assert v >= (3, 12), f"Python 3.12+ required, found {v.major}.{v.minor}"
print(f"python {v.major}.{v.minor} ok")
PY

if python3 -c "import requests" 2>/dev/null; then echo "python deps ok (requests present)"
elif python3 -m pip --version >/dev/null 2>&1; then python3 -m pip install -q -r requirements.txt && echo "python deps ok"
else echo "python3 has no pip (is it a venv shim?): run  python3 -m ensurepip  or  brew install python  then re-run"; exit 1; fi

if ! need brew; then echo "Homebrew missing: install from https://brew.sh, then re-run"; exit 1; fi
for pkg in ffmpeg imagemagick; do
  bin=$pkg; [ "$pkg" = imagemagick ] && bin=magick
  if need "$bin"; then echo "$pkg ok ($(command -v "$bin"))"; else echo "installing $pkg"; brew install "$pkg"; fi
done
magick -list format | grep -qi heic && echo "HEIC support ok" || echo "warning: ImageMagick has no HEIC support; iPhone photos will be rejected"

[ -f .env ] || { cp .env.example .env; echo "created .env from .env.example: fill in NIMBLE_API_KEY, BFL_API_KEY, OPENROUTER_API_KEY"; }
mkdir -p data images videos
echo "setup done. Next: python3 test_pipeline.py (no credits), then python3 dashboard.py"
