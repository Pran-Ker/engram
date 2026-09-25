# Direct avatar engram mode

Engram has two ways to make a person.

| | Hyper-personalized (the original path) | Direct (this page) |
|---|---|---|
| Built from | notes written by hand, 6–12 photos, 45–90 min of recorded speech | one research record (for example a row of an enrichment CSV), one photo, optionally one talking clip |
| Brain | Liquid `LFM2.5-1.2B` on local Ollama | Liquid `LFM2.5-2.6B` on OpenRouter (`liquid/lfm-2.5-2.6b:free`), no local model |
| Voice | `LFM2.5-Audio` fine-tuned on the person, served from Modal | the base voice (`run: "base"`), or the transcript when no voice service is up |
| Face | `flux-2-pro` portrait → `flux-3-video` idle and talk loops | the photo as poster, a breathing idle loop made with ffmpeg, the supplied clip as the talk loop |
| Memory, live web, RawTree events, Inspect | yes | yes, unchanged: the chat route is the same |
| Created by | editing `engrams/<slug>/` | `POST /api/direct/engrams` |
| Owned by | Prannay's workstream | the direct workstream (`server/routes/direct.ts`, `server/lib/direct/`, this page) |

A direct engram is a normal engram folder. The manifest carries `"mode": "direct"` and `"brain": { "provider": "openrouter" }`; everything else on the stage, in the context bank and in Inspect works as before. The hyper path never reads these fields, and its defaults are unchanged when they are absent.

## Create one

```bash
export OPENROUTER_API_KEY=sk-or-...        # the only extra key direct mode needs
curl -s -X POST http://localhost:4100/api/direct/engrams \
  -H 'Content-Type: application/json' \
  -d '{
    "full_name": "Yaniv Markovski",
    "headline": "Head of Ecosystem Engineering",
    "current_company": "Nimble",
    "location": "San Francisco, California",
    "bio_summary": "Yaniv Markovski is Head of Ecosystem Engineering at Nimble ...",
    "company_description": "Nimble is an AI-powered web data platform ...",
    "company_recent_news": "In February 2026 Nimble raised a $47M Series B ...",
    "past_companies": "AI21 Labs; OpenAI; Mapbox",
    "avatar_speech": "Hi, I'm Yaniv Markovski, Head of Ecosystem Engineering at Nimble. ...",
    "posts": [{"url": "https://www.linkedin.com/posts/...", "snippet": "...", "platform": "linkedin"}],
    "photo": "data:image/jpeg;base64,...",
    "clip": "data:video/mp4;base64,..."
  }'
```

Response `201`:

```json
{"slug":"yaniv-markovski","name":"Yaniv Markovski","cards":7,"video":{"idle":"video/idle.mp4","talk":"video/talk.mp4","poster":"video/poster.jpg","talkFrom":"clip"},"photo":true,"mode":"direct","url":"/e/yaniv-markovski"}
```

Open `http://localhost:4173/e/yaniv-markovski` and ask a question. The call is idempotent: posting the same person again rewrites the manifest, the direct-owned cards and the loops, and leaves `memory-*` cards and anything added by hand alone.

#The reference client is [`../../dashboard/`](../../dashboard/README.md): its **Talk to me** button builds exactly this request (`export_engram.py`) from a researched person and opens the stage.

## The record

Any JSON object with a name. Field names follow the [longhorizonhack](https://github.com/cheese-cracker/longhorizonhack) `people.csv` columns so a row can be posted as is; the short aliases on the left work too.

| Field (aliases) | Becomes |
|---|---|
| `name` (`full_name`) — required | manifest name, persona |
| `slug` (`person_id`) | folder name; defaults to a slug of the name |
| `headline` (`title`), `company` (`current_company`) | tagline, persona, `work-01-role` |
| `bio` (`bio_summary`), `location`, `education` | `profile-01-who`, rewritten to first person |
| `company_description`, `company_tagline`, `company_products`, `company_customers`, `company_founders`, `company_founded_year`, `company_funding_stage`, `company_hq_location`, `company_competitors`, `company_url` | `work-01-role`, `work-02-company` |
| `company_recent_news`, `recent_signals` | `work-03-recent` |
| `past_companies` | `story-01-career` |
| `speech` (`avatar_speech`), `pitch` (`pitch_script`) | `voice-01-in-my-words`, as `Q: … A: …` lines the brain uses as few-shot examples |
| `posts[]` — `{url, snippet, platform, posted_at}` | one `live-post-NN-*` card each, up to 12, source = the post URL |
| `pronouns` | manifest; also drives the third-to-first-person rewrite (name-based when absent) |
| `sources` (`source_urls`) | card `source` when nothing more specific applies |
| `photo` — `data:` URI or URL, JPEG/PNG/WebP, ≤ 12 MB | `photos/01.<ext>`, poster, idle loop |
| `clip` — `data:` URI or URL, mp4, ≤ 60 MB | `video/talk.mp4` (letterboxed to 1920×1080, audio dropped); without it the idle loop doubles as talk |

Cards are matched to questions by keyword overlap, so the record should carry concrete nouns: company names, products, places, years.

## What the direct brain does differently

`server/lib/direct/openrouter.ts` streams `POST /chat/completions` from OpenRouter with the same message shape `lib/prompt.ts` builds for Ollama, and yields only content deltas: the free Liquid endpoint reasons before it answers and that reasoning is dropped, which is also why `max_tokens` is 600 rather than Ollama's `num_predict: 80`. When a reply comes back empty (all budget spent on reasoning) the call is retried once with three times the budget; a `429` from the free tier is retried once after a short wait; `top_p` is not sent because Liquid's provider rejects it. The chat route stops after three sentences either way. `routes/chat.ts` picks the stream from `manifest.brain.provider`; that one line and the optional fields in `shared/types.ts` are the only touches on the shared path.

Health: `GET /api/direct/health` reports the key, the model and the last call. The main `/api/health` still describes the hyper path (Ollama, Modal).

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | | required for direct engrams to answer |
| `DIRECT_MODEL` | `liquid/lfm-2.5-2.6b:free` | any OpenRouter chat model id |
| `OPENROUTER_URL` | `https://openrouter.ai/api/v1` | |
| `DIRECT_MAX_TOKENS` | `600` | budget per answer; when the model spends it all reasoning and says nothing, the client retries once at three times this |

`ffmpeg` must be on the `PATH` for the loops. No Ollama, Modal or BFL key is needed to create and chat with a direct engram.

## Files

| Path | Role |
|---|---|
| `server/routes/direct.ts` | `POST /api/direct/engrams`, `GET /api/direct/health` |
| `server/lib/direct/person.ts` | record → manifest + cards; first-person rewrite; owned card ids |
| `server/lib/direct/video.ts` | photo (+ clip) → `idle.mp4`, `talk.mp4`, `poster.jpg` |
| `server/lib/direct/openrouter.ts` | streaming OpenRouter client, same shape as `lib/liquid.ts` |
| `shared/types.ts` | `mode`, `brain.provider` (optional) |
| `server/routes/chat.ts` | one-line provider switch |
| `server/lib/prompt.ts` | fallback cards: first work card when there is no `work-05` |
