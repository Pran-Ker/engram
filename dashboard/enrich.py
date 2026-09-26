"""Enrich people.csv rows via Nimble: search (posts/sources), extract (verified image), agent run (structured fields)."""
import csv, json, os, re, sys, threading, time
from pathlib import Path
from urllib.parse import urlparse
import requests

ROOT = Path(__file__).parent
DATA, IMAGES, RAW = ROOT / "data", ROOT / "images", ROOT / "data" / "raw"
API = "https://sdk.nimbleway.com/v2"

if (ROOT / ".env").is_file():  # local convenience; hosted deployments set real environment variables instead
    for line in (ROOT / ".env").read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1); os.environ.setdefault(k.strip(), v.strip())
S = requests.Session()
S.headers.update({"Authorization": f"Bearer {os.environ.get('NIMBLE_API_KEY', '')}", "Content-Type": "application/json"})

AGENT_FIELDS = ["full_name", "headline", "seniority", "location", "bio_summary", "linkedin_url", "twitter_url", "github_url",
                "personal_site", "current_company", "company_url", "company_domain", "company_description", "company_industry", "company_size",
                "company_hq_location", "company_funding_stage", "company_tagline", "company_products", "company_customers",
                "company_founded_year", "company_founders", "company_competitors", "company_recent_news",
                "past_companies", "education", "recent_signals", "pitch_script", "avatar_speech"]
POST_PATTERNS = re.compile(r"linkedin\.com/(posts|pulse)/|(x|twitter)\.com/[^/]+/status/|medium\.com|substack\.com|youtube\.com/watch|podcast", re.I)


def ensure_data_files():
    """Fresh checkout: the CSVs are gitignored, so create each from its committed .example header."""
    for name in ("people", "person_posts", "person_images"):
        p, example = DATA / f"{name}.csv", DATA / f"{name}.csv.example"
        if not p.is_file() and example.is_file(): p.write_text(example.read_text())
ensure_data_files()


CSV_LOCK = threading.Lock()  # held only for a read-modify-write of one CSV, never across an API call


def fields_of(p): return next(csv.reader(open(p, newline="", encoding="utf-8")))
def read_csv(p): return list(csv.DictReader(open(p, newline="", encoding="utf-8")))


def merge_rows(p, changed, key="person_id"):
    """Write only these rows into the table: re-read it under the lock so concurrent jobs never clobber each other."""
    with CSV_LOCK:
        rows = read_csv(p); fields = fields_of(p); by = {r[key]: i for i, r in enumerate(rows)}
        for r in changed:
            row = {f: r.get(f, "") for f in fields}
            if r[key] in by: rows[by[r[key]]] = row
            else: rows.append(row)
        write_csv(p, rows, fields)
def write_csv(p, rows, fields):
    tmp = Path(p).with_suffix(Path(p).suffix + ".tmp")
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields); w.writeheader(); w.writerows(rows)
    os.replace(tmp, p)  # atomic: a concurrent reader never sees a half-written file


def nimble(method, path, **kw):
    """One Nimble call; turns auth/credit problems into a readable error instead of a KeyError later."""
    if not os.environ.get("NIMBLE_API_KEY"): raise RuntimeError("NIMBLE_API_KEY is not set (put it in .env or the environment)")
    r = S.request(method, f"{API}{path}", timeout=120, **kw)
    if r.status_code in (401, 403): raise RuntimeError(f"Nimble rejected the API key ({r.status_code}).")
    if r.status_code == 402: raise RuntimeError("Nimble: out of credits (402).")
    try: return r.status_code, r.json()
    except ValueError: raise RuntimeError(f"Nimble returned non-JSON ({r.status_code}): {r.text[:200]}")
def append_rows(p, rows, key):
    with CSV_LOCK:
        existing = read_csv(p); seen = {(r["person_id"], r[key]) for r in existing}
        new = [r for r in rows if (r["person_id"], r[key]) not in seen]
        write_csv(p, existing + new, fields_of(p) if existing or Path(p).is_file() else list(new[0].keys()))
    return len(new)
RAW.mkdir(exist_ok=True)
def dump(pid, name, obj): (RAW / f"{pid}.{name}.json").write_text(json.dumps(obj, indent=1))
def platform_of(url):
    h = urlparse(url).netloc.lower()
    return next((p for p in ("linkedin", "twitter", "x.com", "medium", "substack", "youtube", "github") if p in h), h.removeprefix("www."))


EVENT_WORDS = {"horizonagentshack", "host", "speaker", "judge"}
def search_posts(row):
    handle = next((u.rstrip("/").rsplit("/", 1)[-1] for u in (row["linkedin_url"], row["twitter_url"], row["github_url"]) if u), "")
    hint = row["current_company"] or " ".join(w for w in row["keywords"].split() if w not in EVENT_WORDS) or handle
    q = f'"{row["full_name"] or handle}" {hint}'.strip()
    _, r = nimble("POST", "/search", json={"query": q, "max_results": 10, "search_depth": "lite"})
    dump(row["person_id"], "search", r)
    results = r.get("results", [])
    posts = [{"person_id": row["person_id"], "platform": platform_of(x["url"]), "post_url": x["url"], "posted_at": "",
              "snippet": (x.get("description") or x.get("title") or "")[:300].replace("\n", " "), "found_via_query": q}
             for x in results if POST_PATTERNS.search(x["url"])]
    return q, [x["url"] for x in results], posts


MAGIC = {b"\xff\xd8\xff": ".jpg", b"\x89PNG": ".png", b"RIFF": ".webp", b"GIF8": ".gif"}
def download_image(pid, img_url, source):
    """Fetch img_url byte-for-byte into images/<pid>/profile-<source><ext>; returns the relative path or '' if not a real image."""
    try:
        resp = requests.get(img_url, timeout=20); resp.raise_for_status()
    except Exception as e: print(f"  image download failed: {e}"); return ""
    ext = next((e for magic, e in MAGIC.items() if resp.content.startswith(magic)), None)
    if not ext: print(f"  rejected image: not a JPEG/PNG/WebP/GIF ({resp.content[:4].hex()})"); return ""
    d = IMAGES / pid; d.mkdir(parents=True, exist_ok=True)
    path = d / f"profile-{source.replace('.com', '')}{ext}"; path.write_bytes(resp.content)
    return str(path.relative_to(ROOT))

HEADSHOT_HOSTS = ("linkedin.com", "x.com", "twitter.com")  # only these put the profile photo in og:image
def extract_image(row, driver=None):
    url = row["linkedin_url"] or row["twitter_url"] or (row["input_query"] if row["input_query"].startswith("http") else "")
    if not url: return None, []
    if not urlparse(url).netloc.endswith(HEADSHOT_HOSTS):
        print(f"  skipping image: {urlparse(url).netloc} og:image is not a profile photo"); return url, []
    body = {"url": url, "formats": ["html", "markdown"], **({"driver": driver} if driver else {"render": "auto"})}
    _, r = nimble("POST", "/extract", json=body)
    dump(row["person_id"], "extract" + (f".{driver}" if driver else ""), r)
    if r.get("status") != "success" or r.get("status_code") != 200:
        print(f"  extract {r.get('status')} http={r.get('status_code')} for {url}"); return url, []
    html = r.get("data", {}).get("html", "")
    m = re.search(r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)', html) or \
        re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image["\']', html)
    if not m: return url, []
    img_url = m.group(1).replace("&amp;", "&")
    if "static.licdn.com" in img_url:
        print("  skipping image: LinkedIn served its auth-wall page (generic static og:image)"); return url, []
    local = download_image(row["person_id"], img_url, platform_of(url))
    if not local: return url, []
    return url, [{"person_id": row["person_id"], "image_url": img_url, "source_page_url": url, "image_type": "headshot",
                  "match_basis": f"og:image on verified profile URL ({platform_of(url)})", "confidence": "high", "local_path": local}]


def start_agent(row):
    record = {k: (row[k] or None) for k in ["full_name", "headline", "current_company", "linkedin_url", "twitter_url"] + AGENT_FIELDS}
    schema = {"type": "array", "items": {"type": "object", "properties": {k: {"type": ["string", "null"]} for k in AGENT_FIELDS}}}
    body = {"input": ("Enrich this person's public professional profile and, in depth, the company they currently work for. "
                      "Only use public sources. seniority: one of IC/Senior IC/Lead/Manager/Director/VP/C-level/Founder. "
                      "Lists (past_companies, education, company_products, company_customers, company_founders, company_competitors) "
                      "are '; '-separated. company_description: 2-3 sentences on what the company does and for whom. "
                      "company_tagline: the company's own one-line positioning. company_recent_news: 1-3 sentences, last 12 months. "
                      "recent_signals: 1-3 sentences on the person's hiring, funding, launches, talks, or job changes in the last 12 months. "
                      "bio_summary: 2-3 sentences. pitch_script: a first-person, spoken-word script of about 80 words in which this person "
                      "introduces themselves and explains what their company does and why it matters, using only the facts you found "
                      "(this narrates a short video). avatar_speech: the same idea compressed to AT MOST 30 words, first person, "
                      "spoken aloud, complete sentences. Leave a field null if not found."),
            "input_data": [record], "output_schema": schema, "use_case": "enrichment", "effort": "medium"}
    code, j = nimble("POST", "/agents/runs", json=body); dump(row["person_id"], "agent_start", j)
    if code >= 300 or "id" not in j: print(f"  agent start failed {code}: {json.dumps(j)[:300]}"); return None
    return j["web_search_agent_id"], j["id"]


def finish_agent(row, ids, timeout=900):
    aid, rid = ids; t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            _, j = nimble("GET", f"/agents/{aid}/runs/{rid}")
            if not j.get("is_active", True): break
        except (RuntimeError, requests.RequestException) as e: print(f"  polling hiccup: {e}")
        time.sleep(10)
    else: print("  agent timed out"); return {}, []
    _, res = nimble("GET", f"/agents/{aid}/runs/{rid}/result"); dump(row["person_id"], "agent_result", res)
    out = res.get("output", res); content = out.get("content")
    if isinstance(content, str):
        try: content = json.loads(content)
        except ValueError: content = {"bio_summary": content}
    if isinstance(content, list): content = content[0] if content else {}
    cites = [c.get("url") for claim in out.get("trust", {}).get("claims", []) for c in claim.get("citations", []) if c.get("url")]
    return content or {}, cites


def enrich(rows, targets):
    todo = [r for r in rows if r["person_id"] in targets]
    started = {}
    for row in todo:
        if row["nimble_queries_used"]:
            print(f"[{row['person_id']}] search + extract already done, skipping")
        else:
            print(f"[{row['person_id']}] search + extract")
            q, urls, posts = search_posts(row)
            prof_url, imgs = (None, []) if has_headshot(row["person_id"]) else extract_image(row)  # an uploaded photo wins
            n_p = append_rows(DATA / "person_posts.csv", posts, "post_url") if posts else 0
            n_i = append_rows(DATA / "person_images.csv", imgs, "image_url") if imgs else 0
            row["source_urls"] = " ".join(dict.fromkeys(filter(None, row["source_urls"].split() + urls + [prof_url])))
            row["nimble_queries_used"] = f"search:lite:{q!r}; extract:{prof_url or '-'}; agent:medium"
            print(f"  {len(urls)} urls, +{n_p} posts, +{n_i} images")
        ids = resumable_agent(row["person_id"])  # a run started by an earlier attempt (restart, retry) is polled, not paid for twice
        if ids: print(f"  resuming agent run {ids[1][:12]}… from an earlier attempt")
        else: ids = start_agent(row)
        if ids: started[row["person_id"]] = ids
        row["enrichment_status"] = "partial"
        merge_rows(DATA / "people.csv", [row])
    for row in todo:
        if row["person_id"] not in started: continue
        print(f"[{row['person_id']}] waiting on agent")
        content, cites = finish_agent(row, started[row["person_id"]])
        if not content:  # Nimble runs occasionally fail "unexpectedly" with no output; one retry has fixed it every time so far
            print("  agent returned nothing — retrying once"); ids = start_agent(row)
            if ids: content, cites = finish_agent(row, ids)
        for k in AGENT_FIELDS:
            v = content.get(k)
            if k == "linkedin_url" and v and "/in/" not in str(v): v = None  # company pages are not a person's profile
            if v and not row[k]: row[k] = str(v).replace("\n", " ").strip()
        row["source_urls"] = " ".join(dict.fromkeys(row["source_urls"].split() + cites))
        if not has_headshot(row["person_id"]) and (row["linkedin_url"] or row["twitter_url"]):
            _, imgs = extract_image(row)  # profile URL was found by the agent, so try the headshot again
            for i in imgs: i["match_basis"] += " (profile URL found by agent research, cited)"; i["confidence"] = "medium"
            if imgs: print(f"  +{append_rows(DATA / 'person_images.csv', imgs, 'image_url')} image from agent-found profile URL")
        row["enrichment_status"] = "complete" if content else "partial"
        row["last_enriched_at"] = time.strftime("%Y-%m-%dT%H:%M")
        print(f"  filled {sum(1 for k in AGENT_FIELDS if content.get(k))}/{len(AGENT_FIELDS)} fields, {len(cites)} citations")
        merge_rows(DATA / "people.csv", [row])  # only this person's row: other jobs may be writing theirs


def resumable_agent(pid):
    """(agent_id, run_id) of a run that was started but never collected — its result is still waiting on Nimble's side."""
    start, done = RAW / f"{pid}.agent_start.json", RAW / f"{pid}.agent_result.json"
    if not start.is_file() or done.is_file(): return None
    try: j = json.loads(start.read_text()); return (j["web_search_agent_id"], j["id"]) if "id" in j else None
    except (ValueError, KeyError): return None


def has_headshot(pid):
    return any(r["person_id"] == pid and r["image_type"] == "headshot" and r["local_path"] for r in read_csv(DATA / "person_images.csv"))


def retry_images(rows, targets, driver):
    for row in (r for r in rows if r["person_id"] in targets):
        print(f"[{row['person_id']}] extract image with driver={driver}")
        _, imgs = extract_image(row, driver=driver)
        print(f"  +{append_rows(DATA / 'person_images.csv', imgs, 'image_url') if imgs else 0} images")


if __name__ == "__main__":
    rows = read_csv(DATA / "people.csv")
    args = sys.argv[1:] or sys.exit("usage: enrich.py <person_id>... | --all | --pending | --images <driver> <person_id>...")
    if args[:1] == ["--images"]: sys.exit(retry_images(rows, set(args[2:]), args[1]))
    if args == ["--all"]: targets = {r["person_id"] for r in rows}
    elif args == ["--pending"]: targets = {r["person_id"] for r in rows if r["enrichment_status"] != "complete"}
    else: targets = set(args)
    enrich(rows, targets)
