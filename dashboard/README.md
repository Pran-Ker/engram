# dashboard — the direct-mode front door

Person + company research tool: type a name / LinkedIn / social URL, get back public posts,
company research, and verified images — built on Nimble's web-data API — then a FLUX 3 talking
clip, then one click to put the person on the Engram stage (`POST /api/direct/engrams`, see
[`../engram/docs/direct-mode.md`](../engram/docs/direct-mode.md)). Python 3.12+, `requests`,
`ffmpeg` and ImageMagick on the PATH; no other dependencies.

```bash
./setup.sh                      # checks Python 3.12+, installs requests, ffmpeg and ImageMagick (brew), creates .env
cp .env.example .env            # NIMBLE_API_KEY, BFL_API_KEY, OPENROUTER_API_KEY (+ ENGRAM_API when Engram is remote)
python3 dashboard.py            # http://127.0.0.1:8765  — Engram's API should be up on ENGRAM_API (default :4100)
python3 test_pipeline.py        # no-credit self-check
```

`data/*.csv`, `images/`, `videos/` and `.env` are gitignored: every person you add stays on your
machine. `data/*.csv.example` show the columns.

## Phase 1 (current)

Manual/scripted enrichment into three linked CSVs under `data/`:

- **`people.csv`** — one row per person: identity, social profile URLs, career context
  (seniority, past companies, education), a deep company block (description, tagline,
  products, customers, founders, competitors, funding, recent news), a `recent_signals`
  free-text field for the person's own hiring/funding/talk/job-change news, and a
  `pitch_script` — a first-person ~80-word narration draft of the person explaining their
  company. End goal: feed `pitch_script` + the verified headshot into a FLUX 3 video with
  synced audio (bfl.ai), so the company block is what the narration is built from.
- **`person_posts.csv`** — one row per public post/mention found, FK'd to `person_id`.
- **`person_images.csv`** — one row per image, FK'd to `person_id`. Every row must trace
  back to a `source_page_url` that was already confirmed to belong to that person (their
  own profile, their own site, or a company team page linked from their profile) — never
  a bare reverse-image or generic search hit. This is the guardrail against attaching the
  wrong person's photo.

Images referenced by `local_path` live under `images/<person_id>/`.

`enrich.py <person_id>... | --all | --pending` runs the pipeline (reads `NIMBLE_API_KEY` from
`.env`): one lite Search for posts/sources, one Extract on the verified profile URL for its
`og:image`, then one `medium`-effort Web Search Agent run (`use_case: enrichment`) that fills
the blank columns with cited sources. Raw API responses land in `data/raw/` for audit.
`data/*.csv`, `data/raw/`, `images/` and `.env` are all gitignored — person data stays local.

Pipeline follows Nimble's own cookbook patterns (SERP → Extract → structured fields, with
a source URL cited per value):
- [Build an enriched lead list](https://www.nimbleway.com/cookbooks/build-an-enriched-lead-list-with-langchain)
- [Build a targeted influencer list](https://www.nimbleway.com/cookbooks/build-a-targeted-influencer-list)
- [Map any market from an ICP prompt](https://www.nimbleway.com/cookbooks/map-any-market-from-an-icp-prompt)

## Phase 2a — talking avatars (Black Forest Labs)

`animate.py [--draft] [--fhd] <person_id>...` turns the largest verified `headshot` row into a
15s talking clip with **one** FLUX 3 call (`POST api.bfl.ai/v1/flux-3-video`, `mode: i2v`,
`generate_audio: true`): the image is pinned as the opening frame and the person speaks the
`avatar_speech` column, lip-synced. Output → `videos/<person_id>[-draft].mp4`, path written to
`avatar_video`. Reads `BFL_API_KEY` from `.env`. Scoped to the 5 speakers only, to keep cost down.

Hard-won constraints (all verified 2026-09-25, see `data/raw/test-i2v-*.json`):
- `keyframes` must be an array of **strings** (URL or `data:image/jpeg;base64,…`); the cookbook's
  `{"image_url": …, "frame_index": 0}` object form is rejected with a 422.
- input image ≥ 256×256 — LinkedIn `og:image` is 200×200 and its 800px URL variant is 403, so a
  derived `profile-linkedin-256.jpg` (Lanczos upscale, original kept) is what gets submitted.
- **`avatar_speech` ≤ 34 words.** 34 words + audio renders; 44 words returned `Error: Server side
  error` 4/4 times, even at 20s. The same error is also partly flaky (a 31-word line failed once,
  then passed unchanged), so `animate.py` retries an `Error` once. Failed runs are not charged.
- drafts (`--draft`, $0.06/s) already render at 960×960 with audio; full HD is $0.17/s.
- BFL's usage policy requires consent from real, identifiable people depicted — get an opt-in.

## Phase 2b — dashboard

```bash
python3 dashboard.py          # http://127.0.0.1:8765  (stdlib http.server, no extra deps)
```

Three steps, each its own click and its own cost:

1. **Create my avatar** — name + profile URL + optional photos of yourself. Photos are stored
   untouched as high-confidence headshots (plus a 256px derived copy if too small for FLUX), a row
   is added, and `enrich.enrich()` runs in a background thread (~$0.10). The card appears with the
   photo, headline, company and description.
2. **Bring to life** — button on any card that has a verified photo and no clip. First press arms
   it (shows the price), second press runs `animate.animate(draft=True)` (~$0.90, or ~$2.55 with the
   HD toggle). If the person has no `avatar_speech`, the first whole sentences of their
   `pitch_script` are used. Cards without a verified photo show **Add a photo** instead.
3. **Click to play** — the clip opens in a modal with the spoken line underneath; it auto-plays the
   first time it is ready.

Hardening (so a click works first time — `python3 test_pipeline.py` checks it, no credits):
- ids are unicode-safe (`Márquez` → `marquez`); URLs are normalised (missing `https://`, `m.`/`www.`,
  post/`details` sub-paths, trailing slashes) and an existing person is matched by profile URL, so
  the same person never gets two rows; LinkedIn *company* pages go to `company_url`.
- photos: JPEG, PNG, WebP, GIF (first frame), HEIC/HEIF/AVIF, ≤8 MB, up to 5. The original is stored
  untouched; `animate.flux_ready()` makes one derived `-flux.jpg` (EXIF-oriented, sRGB, alpha
  flattened on white, min side ≥256, max side ≤2048) and BFL's `aspect_ratio` is chosen from the
  image. Unusable files are reported back on the form, never dropped silently. Uploads beat scraped
  photos; derived copies are never used as a source.
- speech: `avatar_speech` → first sentences of `pitch_script` → "Hi, I'm X, headline at company";
  double quotes stripped; ≤34 words.
- APIs: readable errors for bad key / no credits / 422 / moderation; retries on 429, 5xx and network
  blips; one automatic retry for BFL's flaky "Server side error" and for an empty Nimble agent run;
  result download verified (mp4) and retried; no image scrape when a photo was uploaded.
- CSV writes are atomic (temp file + rename), so the page never reads a half-written table.
- **Dev mode** (switch in the page header, remembered per browser; `/#dev` also turns it on) shows a
  dev panel with the pipeline log (auto-expanded) and a "Run speech check" button, plus per-card
  id/status/clip path and, for rendered clips, a Whisper score with what was heard.
- **Speech check (dev tool, not a gate)** — the button runs `verify_clips.py` locally (no credits;
  or `uv run --python 3.12 --with faster-whisper python verify_clips.py`).
  Scores go to `speech_heard` / `speech_match` in `people.csv`. Known behaviour: FLUX slurs or
  swaps words in the densest 32–34-word lines (one clip said "at Meta" for "on LinkedIn's team");
  shorter, plainer lines come out cleaner. Nothing blocks on the score.

Loaders: a step indicator with spinner, elapsed time and streaming log under the form, and a spinner
veil on the card being processed; an in-flight job is picked up again after a page reload. One job
at a time (global lock) so the CSVs never race. A consent checkbox gates step 1; the live BFL
balance is shown on the form. The 4 speaker clips are pre-rendered; everyone else is on demand.

API: `GET /api/people`, `POST /api/generate {name, url, images:[{name,data(dataURL)}], consent, hd,
step: "enrich"}` or `{person_id, step: "animate", consent, hd}`, `GET /api/status?id=`,
`GET /api/credits`, static `/images/*` and `/videos/*` (path-traversal safe).

Everything is local files today; `PLAN-hosting.md` is the (unstarted) plan for moving data, media,
click events and the dashboard to hosted services.

## Phase 3 — talk to the avatar (Engram direct mode)

Cards with a clip carry a **Talk to me** button. It calls `POST /api/engram/<person_id>` here, which runs
`export_engram.py`: the person's row, posts, FLUX-ready headshot and clip are posted to Engram's
`POST /api/direct/engrams`, then **`/talk/<person_id>`** opens — a conversation page in this dashboard's own
theme (`talk.html`). The avatar is the card-sized headshot; while an answer is spoken the muted "bring to
life" clip plays so the mouth moves, idle shows the photo with a slow breathe. Answers stream from Engram's
direct-mode `/chat` (Liquid LFM2.5 on OpenRouter). Voice: Engram's Liquid-Audio `/tts` when a voice service
is deployed, otherwise the browser's speech synthesis — direct engrams need no voice fine-tune. A mic button
appears where the browser supports speech recognition. The page also links to the original Engram stage.

**Spoken video replies** (default on the talk page): the brain's text goes to `POST /api/reply-clip/<person_id>`,
which asks FLUX 3 to render the avatar saying it (`animate.render_clip`, draft, 5–20 s sized to the words,
~$0.60–1.00, 1–2 min); the clip plays with its own voice over the card. Cached per person + text under
`videos/replies/`. Untick the box for the instant voice (Engram's Liquid Audio if deployed, else the browser).
Direct-mode answers are kept to ≤30 words so FLUX can voice them.

Engram must be running (`npm run dev` in `../engram` with `OPENROUTER_API_KEY` set). **Talk to me** re-exports
only when the person's row, photo or clip changed since the last export (`data/raw/engram-exports.json`), so
re-opening a conversation is instant; it never waits on the pipeline lock.

Nothing is tied to localhost. Addresses come from the environment (or `.env`):

| Variable | Default | Meaning |
|---|---|---|
| `ENGRAM_API` | `http://127.0.0.1:4100` | Engram's API; a Railway URL once it is deployed |
| `ENGRAM_STAGE` | Vite `http://localhost:4173` in dev, else `ENGRAM_API` | where "Talk to me" opens; deployed Engram serves the stage from the API origin |
| `HOST`, `PORT` | `127.0.0.1`, `8765` | dashboard bind address; Railway injects `PORT`, set `HOST=0.0.0.0` there and put it behind auth (the page can spend credits) |

Later: a Liquid AI model as the cheap router/summariser in front of the Nimble calls too.
