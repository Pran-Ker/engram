# Engram: contracts every workstream builds against

One sentence: **an Engram is a person you can stand in front of and talk to: their face, their voice, their memories.**
Demo: 3 minutes on stage at the Long Horizon Agents Hackathon (Sept 25 2026). It must look like a shipped product, never glitch, and answer in real time.

## Layout of this repo

```
engram/
  server/            Hono API on :4100 (tsx). Routes are one file each, mounted in server/index.ts.
    routes/engrams.ts   list/load engrams, serve video clips           (scaffold, done)
    routes/chat.ts      POST /:slug/chat  SSE, Liquid via Ollama        (brain)
    routes/context.ts   context bank read + Nimble "add from the web"   (brain)
    routes/events.ts    RawTree event log insert/query                  (brain)
    routes/tts.ts       POST /:slug/tts  audio/wav, Modal LFM2.5-Audio or Gemini TTS   (voice)
    routes/inspect.ts   finetune runs, checkpoints, flags               (inspect)
    routes/health.ts    GET /api/health                                 (brain)
    lib/                engram-store.ts (done), liquid.ts, nimble.ts, rawtree.ts, tts-*.ts
  web/               Vite + React 19 + TS on :4173, proxies /api -> :4100. No UI library. Hand CSS with tokens.css.
    src/pages/EngramPage.tsx    the stage (frontend)
    src/pages/InspectPage.tsx   the Inspect / finetune review page (inspect)
    src/components/             shared: VoiceBar, Transcript, VideoStage, ContextBank, EngramDrawer, ...
    src/lib/api.ts              typed client (done), audio.ts (playback queue + analyser), speech.ts (mic)
  shared/types.ts    the wire types. Change here first, then both sides.
  engrams/<slug>/    one folder per person = one engram. Adding a person = adding a folder.
    engram.json      manifest (EngramManifest)
    context/*.md     one card per file; frontmatter: section, title, source, updatedAt
    photos/          reference photos of the person (input to the video pipeline)
    video/           idle.mp4, talk.mp4, poster.jpg (output of the video pipeline)
  pipelines/video/   BFL FLUX pipeline: photos -> portrait -> idle/talk loops (video)
  ../voice/          the LFM2.5-Audio fine-tune (Modal). voice/serve.py = TTS web endpoint (voice)
  review/            samples for Prannay to review: wavs, mp4s, screenshots + review/index.html
  docs/              CONTRACTS.md (this), README at repo root, docs/*.md (docs)
```

    routes/direct.ts    POST /direct/engrams: research record -> engram folder   (direct mode)
    lib/direct/         openrouter.ts, person.ts, video.ts                      (direct mode)

Ownership: a workstream edits only its files above plus new files it creates. Direct mode (docs/direct-mode.md) is its own workstream: it owns `routes/direct.ts`, `lib/direct/`, and the direct-written card ids, and touches the shared path only through `brain.provider` in `chat.ts` and two optional manifest fields. `server/index.ts`, `package.json`, `shared/types.ts`, `web/src/main.tsx`, `web/src/tokens.css` are shared: append, never rewrite, and keep exports/routes compatible.

## Sponsors, where each is used (all four must be real calls, not logos)

| Sponsor | Used for | Where |
|---|---|---|
| Liquid AI | brain: `LFM2.5-1.2B-Instruct` via Ollama (`localhost:11434`), answers in Prannay's voice. Voice: `LFM2.5-Audio-1.5B` fine-tuned on his recordings, served from Modal | `server/lib/liquid.ts`, `../voice/` |
| Black Forest Labs | face: FLUX image (portrait from reference photos) + `flux-3-video` i2v idle/talk loops | `pipelines/video/` |
| Nimble | live context: "add from the web" in the Context bank, and the brain pulls a Nimble search when a question needs fresh facts | `server/lib/nimble.ts` |
| Tinybird RawTree | memory + analytics: every turn/latency/fallback logged to `lh_engram_events`, the Inspect page charts read from it. Shared cluster: **all tables prefixed `lh_`**, database `default` | `server/lib/rawtree.ts` |

Keys come from `~/.local/secrets` (`source` it before `npm run dev`): `NIMBLE_API_KEY`, `BFL_API_KEY`, `RAWTREE_API_KEY`, `MODAL_TOKEN_ID/SECRET`. Never write keys into the repo.

## API

All under `/api`. JSON unless stated. Errors: `{ error: string }` with a real status code.

| Method, path | Body | Returns |
|---|---|---|
| GET `/engrams` | | `EngramSummary[]` |
| GET `/engrams/:slug` | | `EngramManifest & { cards: number }` |
| GET `/engrams/:slug/video/:clip` | clip = `idle` \| `talk` \| `poster` \| `intro` | file, supports Range. 404 `clip not generated yet` until the pipeline runs. `intro` exists only for direct engrams built from a clip: the source clip with its audio (`manifest.intro.video`), played first on the talk page |
| GET `/engrams/:slug/reply/health` | | `{ ok, detail? }`: whether FLUX video replies are possible for this engram (dashboard at `DASHBOARD_URL` up, person known there, verified photo) |
| POST `/engrams/:slug/reply` | `{ text, hd? }` | proxy to the dashboard's `POST /api/reply-clip/:person` (FLUX 3 renders the face saying `text`). Returns its job record with `url` rewritten to `/engrams/:slug/reply/clip/<file>`; `status` = `rendering` \| `done` \| `failed` |
| GET `/engrams/:slug/reply?job=` | | poll a render, same record |
| GET `/engrams/:slug/reply/clip/:file` | | the rendered mp4, streamed from the dashboard |
| GET `/engrams/:slug/context` | | `ContextCard[]` sorted by section then id |
| POST `/engrams/:slug/context/web` | `{ query }` | Nimble search -> writes new `section: live` cards into `engrams/<slug>/context/live-*.md` -> returns the new `ContextCard[]` |
| POST `/engrams/:slug/context` | `{ section, title, body, source }` | writes a card, returns it (used for "memory" cards the brain saves after a conversation) |
| POST `/engrams/:slug/chat` | `{ messages: ChatMessage[], sessionId }` | **SSE** (`text/event-stream`), one `data: <ChatEvent JSON>\n\n` per event. Order: optional `context`, `token`*, `sentence` (emitted as soon as a sentence boundary is seen, so the client can start TTS while the model is still writing), ..., `done`. First token target < 600 ms locally. |
| POST `/engrams/:slug/tts` | `{ text, turnId? }` | `audio/wav` 24 kHz mono PCM16. Header `x-voice-provider`: `modal:<run>` \| `gemini:<voice>` \| `modal:base` \| `local:say`. Provider chain (`ENGRAM_TTS_PROVIDER=auto`, default): fine-tuned run on Modal when it exists -> Gemini 2.5 Flash TTS (`GEMINI_API_KEY`, voice `GEMINI_TTS_VOICE`, default Puck) -> base LFM2.5-Audio on Modal -> local `say` (dev only, never on stage). `ENGRAM_TTS_PROVIDER=gemini|modal|local` forces the first family. Every fallback logs a `tts_fallback` event. |
| POST `/engrams/:slug/tts/stream` | `{ text, turnId? }` | chunked raw PCM16 LE mono 24 kHz (`x-voice-rate: 24000`, `x-voice-format: s16le mono`, `x-voice-provider`, `x-voice-cache`). First chunk ~1.3 s on Modal, ~1.5–2.5 s on Gemini (clauses of ≤18 words are generated in parallel and streamed in order, so the rest of a long reply lands while the first clause plays). 503 JSON when unavailable: fall back to `/tts`. Tees into the same disk cache. The stage uses this route first. The stream route holds the first `clamp(0.15 × estimated duration − 0.6 s, 0.4 s, 1.6 s)` of audio before releasing (nothing for short sentences), and the client holds 0.7 s more, so a sentence plays gapless even when Modal generates at ~0.8x real time. |
| POST `/events` | `Omit<EventRow,'ts'>` | `{ ok: true }` (RawTree insert, table `lh_engram_events`; buffer + flush, never block the caller) |
| GET `/events?engram=&since=&limit=` | | `EventRow[]` from RawTree |
| GET `/inspect/:slug/runs` | | fine-tune runs + checkpoints + curves (see inspect) |
| GET `/inspect/:slug/turns` | | last 50 turns from RawTree (fixtures when empty). RawTree is append-only, so a turn removed by hand is listed in `review/inspect-hidden.json` (`{ [slug]: turnId[] }`, gitignored) and skipped here |
| GET `/health` | | `Health` |
| POST `/direct/engrams` | person record + `photo?`, `clip?` (data URI or URL) | writes `engrams/<slug>/` with `mode: direct`, `brain.provider: openrouter`; returns `{ slug, cards, video, url }` (direct mode, see docs/direct-mode.md) |
| GET `/direct/health` | | OpenRouter key/model/last call for direct engrams |

## The stage (web `/` and `/e/:slug`)  — good-product profile: **calm**

From Prannay's sketch: a wide display in the middle, a collapsed list of engrams on the left, a context bank on the right, and a bottom bar with start/pause, a voice bar, and the transcript.

```
┌──┬────────────────────────────────────────────────────────────────┬──┐
│ >│  Prannay Hebbar            (name, quiet, centered)          ≡  │  │   top row: drawer toggle · name · context toggle
│  ├────────────────────────────────────────────────────────────────┤  │
│  │                                                                │  │
│  │                   VIDEO (idle loop / talk loop)                │  │   video fills, letterboxed, poster until ready
│  │                                                                │  │
│  ├────────────────────────────────────────────────────────────────┤  │
│  │ [●]  ▂▃▅▇▆▃▂▁▂▃▅▇▆▅▃▂▁ voice bar (SoundCloud style)  │ transcript│   bottom bar, fixed height
└──┴────────────────────────────────────────────────────────────────┴──┘
```

- **Left drawer** (closed by default, slides over, shared by the stage and the talk page): list of engrams from GET `/engrams` with name, tagline and three small readiness marks (voice, face, context). The row opens the engram on the current surface (`/e/:slug` on the stage, `/talk/:slug` on the talk page); a small pill on the row's right ("Talk" or "Stage") opens the other surface. Blank state explains the two ways to add one (a folder, or **Talk to me** on the dashboard).
- **Display**: two `<video>` elements stacked (idle + talk), both `muted loop playsinline preload=auto`, cross-faded by opacity over 400 ms driven by `speaking` state. Poster image until both have `canplaythrough`. If a clip 404s, show the poster with one line: "Face not generated yet. Run `npm run video:build prannay`." No spinners on stage.
- **Start / pause** (the only accent-colored control on the page). Start = ask for the mic, begin listening (Web Speech API, `webkitSpeechRecognition`, continuous, interim results). Pause = stop listening, stop speaking, keep transcript. Space bar toggles when nothing is focused.
- **Voice bar**: SoundCloud style. Bars in `--accent` above a baseline with a faded mirrored reflection below (see `~/Downloads/voicebar.png`). Driven by a Web Audio `AnalyserNode` on the engram's playback (speaking) and by the mic level when listening (dim, `--fg-2`). Bars scroll left as time passes so the last ~12 s are visible. Canvas, 60 fps, devicePixelRatio aware.
- **Transcript** (right part of the bottom bar, fixed width ~ 340 px): the live conversation. User lines in `--fg-1`, engram lines in `--fg`, the sentence currently being spoken in `--accent`. Interim speech shown italic. Auto-scrolls to the bottom. Nothing else: no timestamps, no avatars.
- **Context bank** (right panel, toggled by ≡, ~ 360 px, slides over): cards grouped by section (Profile, Story, Work, Opinions, How he talks, Memories, Live from the web). Each card: title, body (markdown-lite: paragraphs + bullets), source in `--fg-2` mono. Cards used in the last answer get a thin `--accent` left border for 4 s. One text field at the top of "Live from the web": "Ask the web about Prannay…" -> POST `/context/web` (Nimble), new cards appear at the top of that section. Blank state for Memories: "Memories appear here after a conversation."
- **States**: every panel ships regular, blank, and error states. Errors are inline sentences that say what happened and what to do, never toasts.
- **Copy**: plain, first person plural fine. No "Oops", no exclamation marks, no "AI".
- **Keys**: Space start/pause, `[` drawer, `]` context bank, `I` inspect, `T` talk page.
- **Theme**: light. One warm neutral base (`--bg` cream, `--bg-2` white cards) and one accent (orange, interactive only); tokens in `web/src/tokens.css`, shared with the dashboard's palette. The video sits in a framed viewport, so studio portraits keep their own dark backdrop and direct-mode loops (letterboxed onto `--bg`) melt into the frame.

## The talk page (web `/talk/:slug`) — good-product profile: **tool**

The same engram as a seated, typed conversation: for direct engrams made from the dashboard, and for anyone who would rather read than stand at the stage.

```
┌──┬──────────────────────────────────────────────────────────┬───┐
│ >│  Viviana Márquez  Developer Relations · Liquid AI   Stage  ≡ │   top row: drawer · name + tagline · stage link · context toggle
├──┴──────────────────────────────────────────────────────────┴───┤
│ ┌──────────┐  ┌──────────────────────────────────────────────┐ │
│ │  face    │  │  intro line (their own first words)          │ │   face card: square crop of the loops; intro clip and
│ │  (square)│  │  you: …                          (ink bubble)│ │   FLUX reply clips play here with sound
│ │          │  │  them: … sentence being spoken in accent     │ │
│ ├──────────┤  │        Spoken by FLUX 3 · 9 s · cached       │ │   note under the bubble; click to replay
│ │ ● STATUS │  ├──────────────────────────────────────────────┤ │
│ │ ☑ video  │  │ [ Ask Viviana something        ] [mic] [Send] │ │   input always visible; mic = the stage's listen loop
│ └──────────┘  └──────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

- **Face card**: poster, idle loop, talk loop (while TTS speaks), `intro` clip (with audio, "Play intro" button until played once), and the FLUX reply clip. Under it: status (Paused, Listening, Thinking, Speaking, Rendering) and, only when `GET /reply/health` says ok, the **Spoken video replies** checkbox (default on).
- **Conversation**: `useEngram` lines as bubbles. User in ink, engram in cream, the sentence being spoken in accent. With video replies on, TTS is skipped (`voice: false`), the whole answer goes to POST `/reply`, the bubble shows the render progress, then the clip plays with sound; the turn stays open (no listening) until it has played. When the render fails the answer stays as text and the note says why.
- **Blank state**: one line on where answers come from plus three suggested questions. **Error state**: `/talk/<unknown>` says there is no such engram and points at the drawer.
- **Keys**: Space listen/stop, `/` focus the input, `[` drawer, `]` context bank, `I` inspect, `S` stage, Esc closes panels.
- **Dashboard hand-off**: **Talk to me** on a dashboard card exports the person (`POST /api/direct/engrams`) and opens `ENGRAM_STAGE/talk/<slug>`; the dashboard's old `/talk/<person>` redirects there. The FLUX render itself stays in `dashboard/dashboard.py`; Engram reaches it through `DASHBOARD_URL` (default `http://127.0.0.1:8765`).

## The Inspect page (web `/inspect/:slug`) — good-product profile: **tool**

Looks like browser DevTools for a person. Dense, mono for numbers, hairline borders, every pixel earns its place. Data can be realistic fixtures where the pipeline doesn't exist yet, but everything that does exist (RawTree events, `voice/checkpoints/*/training_args.json`, samples) must be real.

```
┌ Prannay Hebbar · prannay-v1 · step 1,840 / 2,400 ─────────────────────── [Load checkpoint ▾] [Distill ▸] ┐
│ Turns (left, 300px)      │ Turn detail: waveform + transcript aligned, video frames strip               │
│  ▸ 14:02  "what are you…"│   drag-select a region -> flag: Voice(pronunciation, pacing, timbre, artifact)│
│  ▸ 14:03  "tell me about"│                                  Face(lip-sync, glitch, lighting, gaze)      │
│  …                       │   flags list under the waveform                                              │
├──────────────────────────┴──────────────────────────────────────────────────────────────────────────────┤
│ Fine-tune: loss / val curves (train, val), speaker-similarity per checkpoint, flags -> distill queue    │
└───────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Video pipeline contract (`pipelines/video/`)

Input: `engrams/<slug>/photos/*.jpg` (6–12 clear photos of the face, chosen from `~/Pictures/Instagram/**`, copied in).
Output: `engrams/<slug>/video/{idle.mp4,talk.mp4,poster.jpg}`. Both mp4s: H.264, 1920x1080 or 1280x720, 24–30 fps, **seamless loop** (ping-pong or crossfade tail->head with ffmpeg), 6–12 s, no audio track, frame 0 == poster. Idle: looking at the camera, breathing, blinking, tiny head motion, neutral-friendly. Talk: same framing and lighting, mouth moving naturally, small gestures. Background: a neutral studio backdrop (the existing hyper engram is on black); the stage shows the clip in a framed viewport on the light page, so the backdrop no longer has to match `--bg`. Direct-mode loops (`server/lib/direct/video.ts`) letterbox onto `--bg` (`0xf3efe7`) so their bars melt into the frame. BFL calls: FLUX image with reference photos for the portrait (try `flux-kontext-pro` / `flux-2-pro` with reference, fall back to `flux-2-klein-4b`), then `POST /v1/flux-3-video` `mode: i2v`. Every render + prompt + cost goes to `pipelines/video/runs.jsonl` and copies land in `review/`.

## Voice contract (`../voice/serve.py`)

Generation is autoregressive at ~1x real time (launch-bound, GPU class does not help), so whole-wav TTS costs about as long as the sentence lasts. Streaming (`/tts/stream`) is what makes the stage feel live. Modal runs 3 warm L4 containers (`ENGRAM_TTS_WARM`, ≈ $2.40/h); one sentence per container at a time; `make tts-stop` when not demoing.

Modal web endpoint `POST /tts {text, run, system_prompt}` -> wav bytes. Loads `/ckpt/<run>/final` if it exists else the base model with the base voice prompt, and reports which in a `x-voice-provider` header. `min_containers=1` while demoing so there is no cold start. Local `server/routes/tts.ts` caches by `sha1(run+text)` on disk under `review/tts-cache/`.

## Review loop with Prannay

Anything that needs his eyes or ears goes to `review/`: `review/index.html` lists every clip and sample with the prompt/params that made it. Publish the page as an artifact and push one notification (`notify` CLI) with the link when a new batch is ready. Batch: never more than one notification per hour.
