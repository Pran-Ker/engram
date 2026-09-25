"""QA gate: transcribe each avatar clip (Whisper, local, no credits) and score it against avatar_speech.

Run:  uv run --python 3.12 --with faster-whisper python verify_clips.py [person_id...]
Writes speech_heard + speech_match (0-100) into people.csv; anything under PASS needs a re-render or a simpler line.
"""
import csv, difflib, os, re, subprocess, sys, tempfile
from pathlib import Path
from faster_whisper import WhisperModel

ROOT = Path(__file__).parent; PEOPLE = ROOT / "data" / "people.csv"
PASS = 80
norm = lambda s: re.findall(r"[a-z0-9']+", s.lower().replace("’", "'"))


def wav_of(mp4):
    out = Path(tempfile.gettempdir()) / (Path(mp4).stem + ".wav")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(mp4), "-vn", "-ac", "1", "-ar", "16000", str(out)], check=True)
    return out


def main(ids):
    rows = list(csv.DictReader(open(PEOPLE, newline="", encoding="utf-8"))); fields = list(rows[0].keys())
    for col in ("speech_heard", "speech_match"):
        if col not in fields: fields.append(col)
    for r in rows: r.setdefault("speech_heard", ""); r.setdefault("speech_match", "")
    model = WhisperModel("medium.en", device="cpu", compute_type="int8")
    for r in rows:
        if not r["avatar_video"] or (ids and r["person_id"] not in ids): continue
        segs, _ = model.transcribe(str(wav_of(ROOT / r["avatar_video"])), beam_size=5)  # unprimed: we want what a listener hears
        heard = " ".join(s.text.strip() for s in segs)
        score = round(100 * difflib.SequenceMatcher(None, norm(r["avatar_speech"]), norm(heard)).ratio())
        r["speech_heard"], r["speech_match"] = heard, str(score)
        print(f"{'PASS' if score >= PASS else 'FAIL'} {score:>3}%  {r['person_id']:22} {heard[:110]}")
    tmp = PEOPLE.with_suffix(".csv.tmp")
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields); w.writeheader(); w.writerows(rows)
    os.replace(tmp, PEOPLE)


if __name__ == "__main__":
    main(set(sys.argv[1:]))
