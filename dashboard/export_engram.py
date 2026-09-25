"""Send one person from people.csv (+ posts, headshot, clip) to Engram's direct mode: POST /api/direct/engrams.

Run:  python3 export_engram.py <person_id> [--engram http://127.0.0.1:4100]
The dashboard's "Talk to me" button calls the same function.
"""
import base64, csv, json, os, sys
from pathlib import Path
import requests
import animate  # also loads .env into the environment

ROOT = Path(__file__).parent
ENGRAM_API = os.environ.get("ENGRAM_API", "http://127.0.0.1:4100").rstrip("/")  # set in .env or the host's variables when Engram is deployed
SKIP = {"avatar_video", "speech_heard", "speech_match", "input_query", "keywords", "enrichment_status", "last_enriched_at", "nimble_queries_used"}


def data_uri(path, mime): return f"data:{mime};base64," + base64.b64encode(Path(path).read_bytes()).decode()


def payload(pid):
    row = next((r for r in animate.read_csv(ROOT / "data" / "people.csv") if r["person_id"] == pid), None)
    if not row: raise ValueError(f"unknown person {pid}")
    posts = [{"url": p["post_url"], "snippet": p["snippet"], "platform": p["platform"], "posted_at": p["posted_at"]}
             for p in animate.read_csv(ROOT / "data" / "person_posts.csv") if p["person_id"] == pid]
    body = {k: v for k, v in row.items() if v and k not in SKIP} | {"posts": posts}
    photo = animate.headshot(pid)
    if photo: body["photo"] = data_uri(animate.flux_ready(photo), "image/jpeg")
    if row["avatar_video"] and (ROOT / row["avatar_video"]).is_file(): body["clip"] = data_uri(ROOT / row["avatar_video"], "video/mp4")
    return body


def export(pid, api=ENGRAM_API):
    """Create or refresh the direct engram; returns Engram's JSON (slug, cards, video, url)."""
    r = requests.post(f"{api}/api/direct/engrams", json=payload(pid), timeout=600)
    try: j = r.json()
    except ValueError: j = {"error": r.text[:300]}
    if r.status_code >= 300: raise RuntimeError(j.get("error") or f"engram {r.status_code}")
    return j


if __name__ == "__main__":
    args = sys.argv[1:] or sys.exit(__doc__)
    api = args[args.index("--engram") + 1] if "--engram" in args else ENGRAM_API
    for pid in [a for a in args if not a.startswith("--") and a != api]:
        print(pid, "→", json.dumps(export(pid, api)))
