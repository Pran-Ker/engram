# Plan: from local files to hosted (not started)

Today everything lives on one laptop: `data/*.csv`, `images/`, `videos/`, `data/raw/` API dumps,
and the dashboard on `127.0.0.1:8765`. Clicks and job progress exist only in the server's memory.
That is fine for the hackathon demo. This is the plan for when it should outlive the laptop.

## What moves where

| Today (local) | Hosted | Why this one |
|---|---|---|
| `people.csv`, `person_posts.csv`, `person_images.csv` | Tinybird **RawTree** (schema-free, agent-native, MCP/SDK) | sponsor; no schema migrations as columns keep changing; SQL-over-HTTP for the dashboard |
| clicks, plays, "bring to life" presses, job stage changes (in-memory `JOBS`) | RawTree via its native **OTLP** endpoint, one event per action | live "which avatars get played" + cost-per-person analytics; free tracing of the pipeline |
| `images/`, `videos/` | object storage (Railway bucket or S3), path stored in the CSV/RawTree row | BFL result URLs expire in ~2h; media must be copied out immediately, same as now |
| `dashboard.py` | Railway service (the imarobot-visuals pattern: Dockerfile + basic auth) | already used for the visuals site; one `railway up` |
| `.env` keys | Railway variables | never in the image or the repo |
| `data/raw/*.json` | keep as blobs in the bucket, keyed by person_id + step | audit trail for every Nimble/BFL call; cheap |

### Engram (direct mode) alongside

Engram's API (`PORT`, serves `web/dist` in production) and this dashboard can be two Railway services;
the dashboard only needs `ENGRAM_API` (and optionally `ENGRAM_STAGE`) pointed at it — no localhost
assumptions remain in `dashboard.py` / `export_engram.py`. Photos and clips currently travel as base64
in the POST; once media is in a bucket, send URLs instead (the direct endpoint accepts both).

## Order, when it happens

1. Events first: emit one JSON event per click/job stage from `dashboard.py` to RawTree (a few
   lines; the CSVs stay the source of truth). This is the cheapest win and the sponsor story.
2. Media to a bucket; `avatar_video` / `local_path` become URLs. `animate.py` uploads instead of
   writing to `videos/`.
3. Tables to RawTree; `enrich.py`/`animate.py` read/write rows through its API instead of CSV.
4. Dashboard to Railway behind basic auth; the pipeline lock becomes a per-person lock or a queue.

## Must not change

- Every image row keeps `source_page_url` + `match_basis` + `confidence`; uploads stay the
  preferred headshot. The wrong-person guardrail is the point of the data model.
- Consent stays a hard gate (checkbox today; a stored consent record with timestamp when hosted).
  BFL's usage policy requires it for real, identifiable people.
- Cost stays visible before every spend (estimate + live BFL balance on the page).

## Open questions

- RawTree is in private beta — do we have access, or start on Tinybird core with a JSON column?
- Per-user auth on the hosted dashboard, or one shared basic-auth password like the visuals site?
- Retention for raw API dumps and for videos of people who withdraw consent (need a delete path).
