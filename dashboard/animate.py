"""Turn a verified headshot into a talking avatar clip with FLUX 3 (image-to-video + native lip-synced speech, one call)."""
import base64, csv, json, math, os, re, subprocess, sys, time
from pathlib import Path
import requests

ROOT = Path(__file__).parent
DATA, VIDEOS, RAW = ROOT / "data", ROOT / "videos", ROOT / "data" / "raw"
IMAGES_CSV = DATA / "person_images.csv"
API = "https://api.bfl.ai/v1"
RATE = {"hd": 0.17, "fhd": 0.29, "draft": 0.06}  # $/second, image-to-video
DURATION = 15
MAX_WORDS = 34  # 34 words + audio renders; 44 words fails with "Server side error" even at 20s (tested 2026-09-25)
MIN_SIDE, MAX_SIDE = 256, 2048  # FLUX rejects keyframes under 256px; the cap keeps the base64 request small
ASPECTS = {"21:9": 21 / 9, "2:1": 2.0, "16:9": 16 / 9, "4:3": 4 / 3, "1:1": 1.0, "3:4": 3 / 4, "9:16": 9 / 16, "9:21": 9 / 21}
RUNNING = ("Pending", "Reasoning", "Generating")

if (ROOT / ".env").is_file():  # local convenience; hosted deployments set real environment variables instead
    for line in (ROOT / ".env").read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1); os.environ.setdefault(k.strip(), v.strip())
H = {"x-key": os.environ.get("BFL_API_KEY", ""), "Content-Type": "application/json"}


def read_csv(p): return list(csv.DictReader(open(p, newline="", encoding="utf-8")))
def write_csv(p, rows, fields=None):
    tmp = p.with_suffix(p.suffix + ".tmp")
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields or list(rows[0].keys())); w.writeheader(); w.writerows(rows)
    os.replace(tmp, p)  # atomic: a concurrent reader never sees a half-written file


def fit(line, n=MAX_WORDS):
    """Longest run of whole sentences within n words; hard-cut if even the first sentence is too long."""
    kept = []
    for s in re.split(r"(?<=[.!?])\s+", line.strip()):
        if len(" ".join(kept + [s]).split()) > n: break
        kept.append(s)
    return " ".join(kept) or " ".join(line.split()[:n])


def dims(path):
    out = subprocess.run(["magick", "identify", "-format", "%w %h", f"{path}[0]"], capture_output=True, text=True, check=True).stdout.split()
    return int(out[0]), int(out[1])


def aspect_for(w, h): return min(ASPECTS, key=lambda k: abs(math.log(w / h) - math.log(ASPECTS[k])))


def record_derived(src, out, basis):
    if not src.is_relative_to(ROOT): return  # not one of our tracked images (e.g. a test file)
    rows = read_csv(IMAGES_CSV); rel_src, rel_out = str(src.relative_to(ROOT)), str(out.relative_to(ROOT))
    orig = next((r for r in rows if r["local_path"] == rel_src), None)
    if orig and not any(r["local_path"] == rel_out for r in rows):
        rows.append(orig | {"local_path": rel_out, "match_basis": f"{orig['match_basis']}; {basis}"}); write_csv(IMAGES_CSV, rows)


def flux_ready(path):
    """Derived copy FLUX accepts: first frame, EXIF-oriented, sRGB, alpha flattened, MIN_SIDE <= side <= MAX_SIDE, JPEG. Original untouched."""
    out = path.with_name(f"{path.stem}-flux.jpg")
    if not out.exists():
        subprocess.run(["magick", f"{path}[0]", "-auto-orient", "-colorspace", "sRGB", "-background", "white", "-alpha", "remove", "-alpha", "off",
                        "-resize", f"{MAX_SIDE}x{MAX_SIDE}>", "-quality", "92", str(out)], check=True, capture_output=True)
        w, h = dims(out)
        if min(w, h) < MIN_SIDE:
            subprocess.run(["magick", str(out), "-filter", "Lanczos", "-resize", f"{math.ceil(MIN_SIDE / min(w, h) * 100)}%", "-quality", "92", str(out)], check=True, capture_output=True)
        record_derived(path, out, f"derived: FLUX-ready copy {'x'.join(map(str, dims(out)))} (oriented, flattened, JPEG; original kept)")
        print(f"  prepared {out.name} {'x'.join(map(str, dims(out)))} from {path.name}")
    return out


def headshot(pid):
    """Best source photo: an upload by the person beats a scraped one, then the largest file. Derived copies are never the source."""
    rows = [r for r in read_csv(IMAGES_CSV) if r["person_id"] == pid and r["image_type"] == "headshot" and r["local_path"]
            and "derived:" not in r["match_basis"] and (ROOT / r["local_path"]).is_file()]
    if not rows: return None
    best = max(rows, key=lambda r: (r["source_page_url"] == "dashboard upload", (ROOT / r["local_path"]).stat().st_size))
    return ROOT / best["local_path"]


def speech_for(row):
    line = row["avatar_speech"].strip() or fit(row["pitch_script"])
    if not line and row["full_name"] and row["headline"] and row["current_company"]:
        line = f"Hi, I'm {row['full_name']}, {row['headline']} at {row['current_company']}."
    return fit(line).replace('"', "'")  # the prompt wraps the line in double quotes


def prompt_for(row):
    return (f"Medium close-up of the person in the reference image, framing and lighting unchanged, looking into the camera. "
            f"Subtle natural head movement, blinking, relaxed expression. They speak directly to camera in their own natural, "
            f"warm, conversational voice, recorded close and clear, finishing comfortably within the clip: "
            f"\"{row['avatar_speech']}\" No on-screen text or subtitles, no background voices.")


def bfl(method, url, **kw):
    """One BFL call with retries on rate limits, 5xx and network blips. 4xx are returned for the caller to explain."""
    if not H["x-key"]: raise RuntimeError("BFL_API_KEY is not set (put it in .env or the environment)")
    for attempt in range(3):
        try:
            r = requests.request(method, url, headers=H, timeout=90, **kw)
            if r.status_code == 429 or r.status_code >= 500: raise requests.HTTPError(f"HTTP {r.status_code}: {r.text[:200]}")
            return r
        except (requests.ConnectionError, requests.Timeout, requests.HTTPError) as e:
            if attempt == 2: raise
            print(f"  BFL {e} — retrying in {5 * (attempt + 1)}s"); time.sleep(5 * (attempt + 1))


def explain_4xx(r):
    return {401: "BFL rejected the API key (401).", 403: "BFL: this key is not allowed to use this endpoint (403).",
            402: "BFL: out of credits (402) — top up at dashboard.bfl.ai."}.get(r.status_code, f"BFL refused the request ({r.status_code}): {r.text[:300]}")


def download(url, out):
    for attempt in range(3):
        try:
            data = requests.get(url, timeout=180).content
            if b"ftyp" in data[:16]: out.write_bytes(data); return True
            raise ValueError("not an mp4")
        except Exception as e:
            print(f"  download failed ({e}), attempt {attempt + 1}/3"); time.sleep(5)
    return False


def animate(row, resolution, draft, retried=False):
    src = headshot(row["person_id"])
    if not src: print(f"[{row['person_id']}] no verified photo — upload one first"); return
    img = flux_ready(src); w, h = dims(img)
    row["avatar_speech"] = speech_for(row)
    if not row["avatar_speech"]: print(f"[{row['person_id']}] nothing to say yet: research found no headline/company and no script"); return
    words = len(row["avatar_speech"].split())
    body = {"mode": "i2v", "prompt": prompt_for(row), "duration": DURATION, "aspect_ratio": aspect_for(w, h), "resolution": resolution,
            "generate_audio": True, "safety_tolerance": 2, "draft": draft,
            "keyframes": [f"data:image/jpeg;base64,{base64.b64encode(img.read_bytes()).decode()}"]}
    print(f"[{row['person_id']}] submitting i2v {resolution}{' draft' if draft else ''}, {w}x{h} → {body['aspect_ratio']}, {words} words, ~${RATE['draft' if draft else resolution] * DURATION:.2f}")
    r = bfl("POST", f"{API}/flux-3-video", json=body)
    try: sub = r.json()
    except ValueError: sub = {"raw": r.text[:300]}
    (RAW / f"{row['person_id']}.video_submit.json").write_text(json.dumps(sub, indent=1))
    if r.status_code >= 400 or "polling_url" not in sub: print(f"  {explain_4xx(r)}"); return
    print(f"  id={sub['id']}")
    last, t0 = None, time.time()
    while time.time() - t0 < 1200:
        try: res = bfl("GET", sub["polling_url"]).json()
        except Exception as e: print(f"  polling hiccup: {e}"); time.sleep(10); continue
        if res.get("status") != last: last = res.get("status"); print(f"  {time.strftime('%H:%M:%S')} {last}")
        if last not in RUNNING: break
        time.sleep(6)
    else:
        print(f"  gave up waiting after 20 min; BFL run {sub['id']} may still finish (GET {sub['polling_url']})"); return
    (RAW / f"{row['person_id']}.video_result.json").write_text(json.dumps(res, indent=1))
    if last == "Error" and not retried:  # BFL's "Server side error" is partly flaky; failed runs are not charged
        print("  BFL server-side error — retrying once"); return animate(row, resolution, draft, retried=True)
    if last in ("Request Moderated", "Content Moderated"):
        print(f"  BFL moderated the {'input photo/prompt' if last.startswith('Request') else 'generated video'}: {json.dumps(res.get('details'))[:300]}"); return
    if last != "Ready": print(f"  {last}: {json.dumps(res.get('details') or res)[:400]}"); return
    VIDEOS.mkdir(exist_ok=True); out = VIDEOS / f"{row['person_id']}{'-draft' if draft else ''}.mp4"
    if not download(res["result"]["sample"], out): print("  could not download the clip (BFL URL expires in ~2h)"); return
    row["avatar_video"] = str(out.relative_to(ROOT))
    print(f"  saved {row['avatar_video']} ({out.stat().st_size // 1024} KB), settled cost={res.get('cost')}")


if __name__ == "__main__":
    args = sys.argv[1:] or sys.exit("usage: animate.py [--draft] [--fhd] <person_id>...")
    draft, resolution = "--draft" in args, "fhd" if "--fhd" in args else "hd"
    ids = [a for a in args if not a.startswith("--")]
    rows = read_csv(DATA / "people.csv")
    print(f"estimate: {len(ids)} clips x {DURATION}s x ${RATE['draft' if draft else resolution]}/s = ~${len(ids) * DURATION * RATE['draft' if draft else resolution]:.2f}\n")
    for row in rows:
        if row["person_id"] in ids: animate(row, resolution, draft)
    write_csv(DATA / "people.csv", rows)
