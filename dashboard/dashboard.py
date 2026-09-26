"""Localhost dashboard: name + social link (+ optional photos) → Nimble enrichment → FLUX 3 talking avatar → click to play."""
import base64, binascii, contextlib, hashlib, io, json, os, re, subprocess, sys, threading, time, unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
import requests
import animate, enrich, export_engram

ROOT = Path(__file__).parent
PEOPLE, IMAGES_CSV = ROOT / "data" / "people.csv", ROOT / "data" / "person_images.csv"
JOBS = {}
LOCKS = {}  # one lock per person: different people's jobs run in parallel; CSV writes are row-merges under enrich.CSV_LOCK
LOCKS_GUARD = threading.Lock()
def person_lock(pid):
    with LOCKS_GUARD: return LOCKS.setdefault(pid, threading.Lock())
ESTIMATE = {"draft": "~$0.10 Nimble agent run + $0.90 FLUX 3 draft clip", "hd": "~$0.10 Nimble agent run + $2.55 FLUX 3 HD clip"}
MAX_UPLOAD = 8 * 1024 * 1024
ICONS = {"/favicon.svg": "image/svg+xml", "/favicon-32.png": "image/png", "/apple-touch-icon.png": "image/png"}
# Engram's stage. Dev: Vite on :4173 (binds ::1, hence localhost). Deployed: the API serves web/dist, so the stage is the API URL.
ENGRAM_STAGE = os.environ.get("ENGRAM_STAGE") or ("http://localhost:4173" if "127.0.0.1" in export_engram.ENGRAM_API else export_engram.ENGRAM_API)
PROFILE_HOSTS = {"linkedin.com": ("linkedin_url", r"^/in/([^/?#]+)"), "x.com": ("twitter_url", r"^/([^/?#]+)"),
                 "twitter.com": ("twitter_url", r"^/([^/?#]+)"), "github.com": ("github_url", r"^/([^/?#]+)")}
NOT_HANDLES = {"in", "company", "posts", "pulse", "status", "home", "explore", "search", "i", "orgs", "settings"}


def slug(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def normalize_url(url):
    """→ (column, canonical URL, handle). Adds https://, drops www./m., query strings and post/detail sub-paths."""
    url = (url or "").strip()
    if not url: return "", "", ""
    if not re.match(r"https?://", url, re.I): url = "https://" + url
    u = urlparse(url); host = u.netloc.lower().removeprefix("www.").removeprefix("m.")
    for h, (col, pat) in PROFILE_HOSTS.items():
        if host == h or host.endswith("." + h):
            if h == "linkedin.com" and u.path.startswith("/company/"): return "company_url", f"https://www.linkedin.com{u.path.rstrip('/')}", ""
            m = re.match(pat, u.path)
            if not m or m.group(1).lower() in NOT_HANDLES: return col, url, ""
            handle = m.group(1)
            canon = {"linkedin.com": f"https://www.linkedin.com/in/{handle}/", "github.com": f"https://github.com/{handle}"}.get(h, f"https://x.com/{handle}")
            return col, canon, handle
    return "personal_site", url, host


def people():
    out = []
    for r in enrich.read_csv(PEOPLE):  # empty on a fresh checkout: the grid just shows the form
        img = animate.headshot(r["person_id"]); job = JOBS.get(r["person_id"], {})
        out.append({k: r[k] for k in ("person_id", "full_name", "headline", "current_company", "bio_summary", "avatar_speech", "avatar_video", "enrichment_status")}
                   | {"image": str(img.relative_to(ROOT)) if img else "", "job": job.get("stage", ""), "step": job.get("step", ""), "reason": job.get("reason", ""),
                      "speech_match": r.get("speech_match", ""), "speech_heard": r.get("speech_heard", "")})
    return out


def add_person(name, url):
    rows = enrich.read_csv(PEOPLE); col, canon, handle = normalize_url(url); key = canon.rstrip("/").lower()
    if key and col != "personal_site":  # same profile already known → reuse, whatever the name was typed as
        for r in rows:
            if r.get(col) and normalize_url(r[col])[1].rstrip("/").lower() == key: return r["person_id"]
    base = slug(name) or slug(handle) or slug(urlparse(canon).netloc)
    if not base: raise ValueError("Could not make an id from that name or URL.")
    if name and not key and any(r["person_id"] == base for r in rows): return base  # same name, no URL to tell them apart
    pid, n = base, 2
    while any(r["person_id"] == pid for r in rows): pid, n = f"{base}-{n}", n + 1
    fields = enrich.fields_of(PEOPLE)  # from the header, so the very first person on a fresh checkout works too
    row = {k: "" for k in fields} | {"person_id": pid, "input_query": name or url, "full_name": name.strip(), "enrichment_status": "pending"}
    if col: row[col] = canon
    rows.append(row); enrich.write_csv(PEOPLE, rows, fields)
    return pid


def sniff(data):
    ext = next((e for magic, e in enrich.MAGIC.items() if data.startswith(magic)), None)
    if not ext and data[4:8] == b"ftyp": ext = ".avif" if data[8:12] in (b"avif", b"avis") else ".heic"
    return ext


def save_uploads(pid, images):
    """Store each photo byte-for-byte as a high-confidence headshot and make its FLUX-ready copy; report anything unusable."""
    d = ROOT / "images" / pid; d.mkdir(parents=True, exist_ok=True); stored, skipped = 0, []
    for i, img in enumerate(images[:5], 1):
        name = img.get("name") or f"photo {i}"
        try: data = base64.b64decode(img["data"].split(",", 1)[-1], validate=True)
        except (binascii.Error, AttributeError, KeyError): skipped.append(f"{name}: not a valid upload"); continue
        if len(data) > MAX_UPLOAD: skipped.append(f"{name}: over 8 MB"); continue
        ext = sniff(data)
        if not ext: skipped.append(f"{name}: not a JPEG/PNG/WebP/GIF/HEIC image"); continue
        path = d / f"upload-{i}{ext}"; path.write_bytes(data)
        row = {"person_id": pid, "image_url": "", "source_page_url": "dashboard upload", "image_type": "headshot",
               "match_basis": "uploaded through the dashboard by the person themselves", "confidence": "high", "local_path": str(path.relative_to(ROOT))}
        enrich.append_rows(IMAGES_CSV, [row], "local_path")
        try: animate.flux_ready(path); stored += 1
        except Exception as e:
            skipped.append(f"{name}: could not be decoded ({type(e).__name__})"); path.unlink(missing_ok=True)
            rows = enrich.read_csv(IMAGES_CSV); enrich.write_csv(IMAGES_CSV, [r for r in rows if r["local_path"] != row["local_path"]], list(rows[0].keys()))
    return stored, skipped


REPLIES = {}  # reply-clip render jobs by key; cached clips answer immediately


def reply_job(pid, src, line, draft):
    """Start (or reuse) a FLUX render of `line`; returns the job record: status rendering|done|failed, url when done."""
    key = f"{pid}-{hashlib.sha1(line.encode()).hexdigest()[:10]}{'' if draft else '-hd'}"
    out = ROOT / "videos" / "replies" / f"{key}.mp4"; seconds = animate.duration_for(line)
    base = {"job": key, "text": line, "seconds": seconds, "words": len(line.split()), "estimate_usd": round(animate.RATE["draft" if draft else "hd"] * seconds, 2)}
    if out.is_file(): return base | {"status": "done", "url": str(out.relative_to(ROOT)), "cached": True}
    if key in REPLIES and REPLIES[key]["status"] == "rendering": return REPLIES[key]
    REPLIES[key] = base | {"status": "rendering", "started": time.time()}
    def run():  # no redirect_stdout here: it is process-wide and would leak into a concurrent pipeline job's log
        try:
            cost = animate.render_clip(animate.flux_ready(src), line, out, f"{pid}.reply", seconds, "hd", draft)
            REPLIES[key] = base | ({"status": "done", "url": str(out.relative_to(ROOT)), "cached": False, "cost": cost} if cost is not None and out.is_file()
                                   else {"status": "failed", "error": "FLUX could not render this reply (see data/raw/%s.reply.video_result.json)." % pid})
        except Exception as e:
            REPLIES[key] = base | {"status": "failed", "error": f"{type(e).__name__}: {e}"}
    threading.Thread(target=run, daemon=True).start()
    return REPLIES[key]


class Log(io.TextIOBase):
    def __init__(self, job): self.job = job
    def write(self, s): self.job["log"] += s; return len(s)


class ThreadPrints:
    """sys.stdout replacement that routes each thread's prints to its own job log (redirect_stdout is process-wide)."""
    def __init__(self, real): self.real, self.sinks = real, {}
    def write(self, s):
        sink = self.sinks.get(threading.get_ident())
        return sink.write(s) if sink else self.real.write(s)
    def flush(self): self.real.flush()
sys.stdout = PRINTS = ThreadPrints(sys.stdout)

@contextlib.contextmanager
def redirect_prints(job):
    PRINTS.sinks[threading.get_ident()] = Log(job)
    try: yield
    finally: PRINTS.sinks.pop(threading.get_ident(), None)


def run_job(pid, step, draft):
    """step 'enrich': Nimble research → avatar card.  step 'animate': (enrich if needed, then) FLUX clip."""
    job = JOBS[pid]
    try:
        with person_lock(pid), redirect_prints(job):
            rows = enrich.read_csv(PEOPLE); row = next(r for r in rows if r["person_id"] == pid)
            if row["enrichment_status"] != "complete":
                job["stage"] = "enriching"; enrich.enrich(rows, {pid})
            row = next(r for r in enrich.read_csv(PEOPLE) if r["person_id"] == pid)
            if step == "animate" and not row["avatar_video"]:
                job["stage"] = "animating"; animate.animate(row, "hd", draft); enrich.merge_rows(PEOPLE, [row])
            ok = row["avatar_video"] if step == "animate" else row["enrichment_status"] == "complete"
            job["stage"] = "done" if ok else "failed"
            if not ok: job["reason"] = failure_reason(job["log"])
    except Exception as e:
        job["stage"] = "failed"; job["log"] += f"\n{type(e).__name__}: {e}"; job["reason"] = failure_reason(job["log"])


def failure_reason(log):
    """Whose fault, in the card's words: ours (fixable here) or the provider's (retry / better input)."""
    if "moderated" in log.lower(): return "BFL moderated it"
    if "server-side error" in log or '"Server side error"' in log: return "FLUX failed (BFL server error)"
    if "no verified photo" in log: return "no photo yet"
    if "out of credits" in log: return "out of credits"
    if "rejected the API key" in log: return "API key rejected"
    if "Nimble" in log and "agent returned nothing" in log: return "Nimble agent returned nothing"
    return "failed"


class Handler(BaseHTTPRequestHandler):
    def send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(data)))
        self.end_headers(); self.wfile.write(data)

    def do_GET(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        if u.path == "/": return self.send(200, (ROOT / "dashboard.html").read_bytes(), "text/html; charset=utf-8")
        if u.path.startswith("/talk/"):  # old links: the conversation now lives on Engram's talk page (web/src/pages/TalkPage.tsx)
            self.send_response(302); self.send_header("Location", f"{ENGRAM_STAGE}/talk/{u.path.rsplit('/', 1)[-1]}"); self.end_headers(); return
        if u.path in ICONS:  # same favicon as the Engram web app (engram/web/public)
            f = ROOT.parent / "engram" / "web" / "public" / u.path.lstrip("/")
            if not f.is_file(): return self.send(404, {"error": "not found"})
            return self.send(200, f.read_bytes(), ICONS[u.path])
        if u.path == "/api/config": return self.send(200, {"engram_api": export_engram.ENGRAM_API, "engram_stage": ENGRAM_STAGE})
        if u.path == "/api/reply-clip": return self.send(200, REPLIES.get(q.get("job", [""])[0], {"status": "unknown", "error": "No such render job (the server may have restarted)."}))
        if u.path == "/api/people": return self.send(200, people())
        if u.path == "/api/status":
            job = JOBS.get(q.get("id", [""])[0], {"stage": "none", "log": "", "started": time.time()})
            return self.send(200, job | {"elapsed": int(time.time() - job["started"])})
        if u.path == "/api/credits":
            try: return self.send(200, requests.get(f"{animate.API}/credits", headers={"x-key": animate.H["x-key"]}, timeout=10).json())
            except Exception as e: return self.send(502, {"error": f"BFL unreachable: {e}"})
        if u.path.startswith(("/images/", "/videos/")):
            f = (ROOT / u.path.lstrip("/")).resolve()  # includes videos/replies/*
            if not f.is_relative_to(ROOT) or not f.is_file(): return self.send(404, {"error": "not found"})
            ctype = "video/mp4" if f.suffix == ".mp4" else "image/" + f.suffix.lstrip(".").replace("jpg", "jpeg")
            return self.send(200, f.read_bytes(), ctype)
        self.send(404, {"error": "not found"})

    def do_POST(self):
        if self.path.startswith("/api/engram/"):  # push this person into Engram's direct mode and hand back the stage URL
            pid = self.path.rsplit("/", 1)[-1]
            if not any(r["person_id"] == pid for r in enrich.read_csv(PEOPLE)): return self.send(404, {"error": "Unknown person."})
            try:
                j = export_engram.export(pid)  # read-only here (CSV writes are atomic), so it must not wait on the pipeline lock
                return self.send(200, j | {"stage": f"{ENGRAM_STAGE}{j['url']}", "talk": f"{ENGRAM_STAGE}/talk/{j['slug']}"})
            except requests.ConnectionError: return self.send(502, {"error": f"Engram API is not running at {export_engram.ENGRAM_API} — start it with `npm run dev` in repos/engram/engram."})
            except Exception as e: return self.send(502, {"error": f"Engram: {e}"})
        if self.path.startswith("/api/reply-clip/"):  # FLUX 3 speaks a reply written by the (Liquid) brain; a background job the page polls
            pid = self.path.rsplit("/", 1)[-1]
            try: body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            except ValueError: return self.send(400, {"error": "Malformed request."})
            line = animate.fit(str(body.get("text") or "").strip()).replace('"', "'")
            if not line: return self.send(400, {"error": "Nothing to say."})
            src = animate.headshot(pid)
            if not src: return self.send(404, {"error": "No verified photo for this person."})
            return self.send(200, reply_job(pid, src, line, not body.get("hd")))
        if self.path == "/api/verify":  # dev mode: Whisper QA over all clips, local and free; runs verify_clips.py
            with enrich.CSV_LOCK:  # it rewrites people.csv itself, so keep row-merges out while it runs
                p = subprocess.run(["uv", "run", "--python", "3.12", "--with", "faster-whisper", "python", str(ROOT / "verify_clips.py")],
                                   capture_output=True, text=True, cwd=ROOT, timeout=1800)
            out = "\n".join(l for l in (p.stdout + p.stderr).splitlines() if "HF_TOKEN" not in l)
            return self.send(200 if p.returncode == 0 else 500, {"output": out} if p.returncode == 0 else {"error": out[-600:]})
        if self.path != "/api/generate": return self.send(404, {"error": "not found"})
        try: body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        except ValueError: return self.send(400, {"error": "Malformed request."})
        name, url, pid = (body.get("name") or "").strip(), (body.get("url") or "").strip(), body.get("person_id")
        if not body.get("consent"): return self.send(400, {"error": "Confirm this is you, or that you have the person's consent."})
        skipped = []
        try:
            if pid:  # Bring to life for someone already in the table
                if not any(r["person_id"] == pid for r in enrich.read_csv(PEOPLE)): return self.send(404, {"error": "Unknown person."})
            else:
                if not name and not url: return self.send(400, {"error": "Give at least a name or a profile URL."})
                pid = add_person(name, url); stored, skipped = save_uploads(pid, body.get("images") or [])
        except ValueError as e: return self.send(400, {"error": str(e)})
        if JOBS.get(pid, {}).get("stage") in ("queued", "enriching", "animating"):
            return self.send(200, {"person_id": pid, "stage": JOBS[pid]["stage"], "step": JOBS[pid]["step"], "skipped": skipped})
        step = body.get("step") or ("animate" if body.get("person_id") else "enrich")
        log = "".join(f"skipped {s}\n" for s in skipped)
        JOBS[pid] = {"stage": "queued", "step": step, "log": log, "started": time.time()}
        threading.Thread(target=run_job, args=(pid, step, not body.get("hd")), daemon=True).start()
        self.send(200, {"person_id": pid, "stage": "queued", "step": step, "skipped": skipped, "estimate": ESTIMATE["hd" if body.get("hd") else "draft"]})

    def log_message(self, *args): pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", 8765))  # Railway injects PORT
    host = os.environ.get("HOST", "127.0.0.1")  # set HOST=0.0.0.0 when hosted (behind auth: the page can spend credits)
    print(f"dashboard: http://{host}:{port}  engram api: {export_engram.ENGRAM_API}  stage: {ENGRAM_STAGE}", flush=True)
    ThreadingHTTPServer((host, port), Handler).serve_forever()
