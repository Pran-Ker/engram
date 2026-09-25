# Engram

An Engram is a person you can stand in front of and talk to: their face, their voice, and their memories. You press start, ask a question out loud, and the person on screen answers in their own voice within about a second, drawing on a context bank of notes about them and, when the question needs fresh facts, on a live web search. One Engram is one folder under `engrams/`. This repo ships one, `prannay`, built for the Long Horizon Agents Hackathon (September 25, 2026).

![The stage: a studio portrait fills the screen under the name Prannay Hebbar, with a start button, a voice bar, and a transcript along the bottom.](docs/img/stage.jpg)

**Figure 1.** The stage at 1920x1080. Drawer toggle at the top left, context bank toggle at the top right, start button and transcript at the bottom.

## How it fits together

```mermaid
flowchart TB
  subgraph web["web/  the browser, Vite on :4173"]
    direction LR
    drawer["EngramDrawer.tsx"]
    stage["EngramPage.tsx  the stage<br/>VideoStage · VoiceBar · Transcript"]
    bank["ContextBank.tsx"]
    inspect["InspectPage.tsx"]
  end

  subgraph server["server/  Hono API on :4100"]
    direction LR
    eng["routes/engrams.ts<br/>list, manifest, video clips"]
    chat["routes/chat.ts<br/>POST /chat  SSE tokens + sentences"]
    tts["routes/tts.ts<br/>POST /tts  audio/wav"]
    ctx["routes/context.ts<br/>cards, Ask the web"]
    ev["routes/events.ts"]
    insp["routes/inspect.ts<br/>runs, turns, flags, distill"]
  end

  subgraph folder["engrams/prannay/  one folder per person"]
    direction LR
    manifest["engram.json"]
    video["video/  idle.mp4 talk.mp4 poster.jpg<br/>written by pipelines/video/build.ts"]
    cards["context/*.md"]
    photos["photos/*.jpg"]
  end

  subgraph sponsors["Sponsors, one real call each"]
    direction LR
    bfl["Black Forest Labs<br/>flux-2-pro, flux-3-video"]
    ollama["Liquid LFM2.5-1.2B-Instruct<br/>Ollama on localhost:11434"]
    modal["Liquid LFM2.5-Audio-1.5B<br/>Modal app engram-tts, run prannay-v1"]
    nimble["Nimble Search"]
    rawtree["Tinybird RawTree<br/>table lh_engram_events"]
  end

  drawer --> eng
  stage --> eng & chat & tts
  bank --> ctx
  inspect --> insp
  eng --> manifest & video
  chat & ctx --> cards
  chat --> ollama & nimble
  ctx --> nimble
  tts --> modal
  chat & tts --> ev --> rawtree
  insp --> rawtree
  photos -. "pipelines/video/build.ts" .-> bfl
```

**Figure 2.** The four layers. The browser talks only to the API. The API reads the engram folder, calls one sponsor per job, and writes every turn to RawTree, which the Inspect page reads back. The video pipeline runs offline and writes into the same folder.

The wire types live in `shared/types.ts` and the route table in `docs/CONTRACTS.md`.

## The four sponsors

Every sponsor is a real call in the request path, not a logo.

| Sponsor | What it does here | Where |
|---|---|---|
| Liquid AI | Brain: `LFM2.5-1.2B-Instruct` runs locally through Ollama and answers as the person, one to three spoken sentences per turn. Voice: `LFM2.5-Audio-1.5B` fine-tuned on the person's recordings, served from Modal. | `server/lib/liquid.ts`, `../voice/` |
| Black Forest Labs | Face: `flux-2-pro` turns reference photos into a studio portrait, then `flux-3-video` (`mode: i2v`) turns that portrait into an idle loop and a talking loop. | `pipelines/video/` |
| Nimble | Live context: the **Ask the web** field in the context bank, and the brain runs a Nimble search when a question mentions today, the hackathon, news, or a date. | `server/lib/nimble.ts` |
| Tinybird RawTree | Memory and analytics: every utterance, first token, TTS call, fallback, and flag is a row in `lh_engram_events` (database `default`). The Inspect page reads its turn list from there. | `server/lib/rawtree.ts` |

`GET /api/health` reports all four plus Ollama in one JSON object.

## Two modes

The folder above is the **hyper-personalized** path: hand-written notes, a fine-tuned voice, a face built from many photos. The same server also runs **direct avatar engrams**: `POST /api/direct/engrams` turns one research record (a lead-enrichment CSV row, say) plus one photo and an optional talking clip into a complete folder, answered by Liquid `LFM2.5` on OpenRouter instead of local Ollama. The stage, the context bank, live web lookups and event logging are shared; only the way the folder is made and which Liquid endpoint answers differ. See [`docs/direct-mode.md`](docs/direct-mode.md).

## Run it

Before you start, you need Node 22, [Ollama](https://ollama.com), `ffmpeg`, `uv`, and the `modal` CLI. Keys live in `~/.local/secrets` and are never written into the repo: `NIMBLE_API_KEY`, `BFL_API_KEY`, `RAWTREE_API_KEY`, `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`.

1. Pull the brain model into Ollama:

   ```bash
   ollama pull hf.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF:Q4_K_M
   ```

2. Deploy the voice service on Modal. This writes `../voice/.tts-url`, which the API reads on each request:

   ```bash
   cd ../voice && make deploy && cd ../engram
   ```

   The service keeps one L4 warm (`min_containers=1`) at about $0.80 per hour. Run `make tts-stop` in `../voice` when you are done.

3. Install and start both dev servers:

   ```bash
   source ~/.local/secrets
   npm install
   npm run dev
   ```

   The API listens on `http://localhost:4100` and the web app on `http://localhost:4173`, which proxies `/api` to the API.

4. Open `http://localhost:4173/e/prannay` and check `http://localhost:4100/api/health`. Every entry should read `"ok": true`.

Optional: rebuild the face with `npm run video:build -- prannay`. See [Adding an engram](docs/adding-an-engram.md) for the full pipeline.

To typecheck everything, run `npm run check`.

### Environment variables

All optional. Defaults are in parentheses.

| Variable | Purpose |
|---|---|
| `PORT` | API port (`4100`) |
| `ENGRAMS_DIR` | Folder of engrams (`engrams`) |
| `OLLAMA_URL`, `LIQUID_MODEL` | Ollama endpoint and model tag override |
| `ENGRAM_TTS_URL` | Voice service URL; overrides `../voice/.tts-url` |
| `ENGRAM_TTS_LOCAL` | Set to `0` to disable the macOS `say` fallback (dev only; never on stage) |
| `TTS_CACHE_DIR` | Cache of synthesized wavs (`review/tts-cache`) |
| `RAWTREE_DATABASE` | RawTree database (`default`) |
| `VOICE_DIR` | Where the Inspect page looks for `checkpoints/` (`../voice`) |

## Using the stage

The stage has four controls and four keys.

| Control | Key | What happens |
|---|---|---|
| Start / Pause (the orange button) | Space | Start asks for the microphone and begins listening. Pause stops listening and speaking but keeps the transcript. |
| Drawer toggle (top left) | `[` | Lists every engram with three readiness marks: voice, face, context. The last row explains how to add one. |
| Context bank toggle (top right) | `]` | Opens the cards the brain answers from, grouped by section. |
| Inspect | `I` | Opens `/inspect/:slug`. |

You can also type into the field under the transcript when a microphone is not available.

![Left drawer listing Prannay Hebbar with green voice, face, and context marks, followed by an Add an engram row.](docs/img/drawer.jpg)

**Figure 3.** The drawer. Each row is one folder under `engrams/`; the marks come from `GET /api/engrams`.

![Context bank panel showing Profile cards titled Who he is and Education, each with its source path in monospace.](docs/img/context-bank.jpg)

**Figure 4.** The context bank. Sections are Profile, Story, Work, Opinions, How he talks, Memories, and Live from the web. Cards used in the last answer get an orange left border for four seconds.

![Bottom bar with the orange start button labeled Thinking, a flat voice bar, and a transcript answering Who are you in the first person.](docs/img/bottom-bar.jpg)

**Figure 5.** The bottom bar while answering a typed question. The sentence being spoken turns orange; the voice bar draws the playback waveform.

What happens on one turn:

1. The browser sends the transcript to `POST /api/engrams/:slug/chat`.
2. The server picks the most relevant cards, adds the persona from `engram.json`, and streams tokens from Ollama over SSE. If the question looks like it needs fresh facts, it says a short filler sentence, runs a Nimble search, and folds the answer into the prompt.
3. As soon as a sentence boundary appears, the server emits a `sentence` event. The browser posts that sentence to `POST /api/engrams/:slug/tts` and queues the wav, so speech starts while the model is still writing.
4. When the answer ends, the server writes a `memory-*.md` card for the session and logs `chat_done` to RawTree.

## Demo script (3 minutes)

Before you walk on: `npm run dev` is running, `GET /api/health` is all green, the stage is open at `/e/prannay` full screen, and the room microphone is selected in Chrome. Have the Inspect page open in a second tab.

| Time | Do | Say |
|---|---|---|
| 0:00 | Stand next to the screen. Press Space. | "This is an Engram. Everything you are about to see and hear was built from a folder: eight photos, a few notes, and my voice." |
| 0:20 | Ask: "Who are you, and what are you working on right now?" | Let the answer play. Point out that the face, the voice, and the words are three different models: FLUX, LFM2.5-Audio fine-tuned on my voice, and LFM2.5 running on this laptop. |
| 0:55 | Ask: "Tell me the Uhaul story." | While it answers, press `]`. The Story card it used lights up orange. "Every answer is grounded in these cards. Nothing is made up." |
| 1:30 | Ask: "What is happening at the Long Horizon hackathon today?" | "It said 'one sec': that is a live Nimble search. The result is now a card under Live from the web." Scroll the bank to show it. |
| 2:05 | Press `I`. | "Every turn you heard is a row in Tinybird. This is the review loop: I drag across the waveform where the voice is off, tag it, and queue a distill run from a checkpoint." Drag a region, pick a tag, click **Distill**. |
| 2:40 | Press `[` on the stage tab. | "Adding a person is adding a folder. That is the whole point: this is a format, not a demo." |
| 2:55 | Press Space to pause. | Stop. |

If the microphone fails, type the question into the field under the transcript. If TTS falls back to the base voice, the transcript still works; say so and move on.

## The review loop

Anything that needs Prannay's eyes or ears goes to `review/`. The API serves it as static files, so `http://localhost:4100/review/batch-1` opens the first review batch: portraits, idle and talk clips, voice samples, brain transcripts, and stage screenshots, each with the prompt and parameters that made it.

| Path | Contents |
|---|---|
| `review/batch-1/index.html` | The review page for batch 1: face, voice, answers, stage, and the decisions needed. |
| `review/video/` | Every portrait candidate, raw i2v clip, final loop, first and last frames, and `verify.json` with loop PSNR. `README.md` explains each file. |
| `review/voice/` | Voice samples from the TTS service. |
| `review/brain-samples.md` | Real transcripts from `POST /chat` with latency and the cards used. |
| `review/screens/` | Stage and Inspect screenshots at several widths. |
| `review/tts-cache/` | Synthesized wavs keyed by `sha1(run + text)`. |
| `review/flags.jsonl`, `review/distill-jobs.jsonl` | Flags and distill jobs saved from the Inspect page. |

Every BFL render, with prompt, parameters, task id, and cost, is appended to `pipelines/video/runs.jsonl`.

## The Inspect page

`/inspect/:slug` is DevTools for a person. It is where voice and face samples get flagged for the next fine-tune.

![Inspect page: turn list on the left, waveform with aligned words and video frames in the middle, loss and voice charts and a distill queue at the bottom.](docs/img/inspect.jpg)

**Figure 6.** Inspect for `prannay`, run `prannay-v1`. The header shows the loaded checkpoint step; the bottom row plots train and validation loss, speaker similarity, and word error rate per checkpoint.

| Region | What it shows | Where the data comes from |
|---|---|---|
| Header | Run id, loaded step, GPU, and the **Load checkpoint** (`L`) and **Distill** (`D`) buttons. | `GET /api/inspect/:slug/runs` |
| Turns | The last 50 turns with latency and voice provider. | RawTree `lh_engram_events`; for `prannay`, fixtures until the table has rows |
| Turn detail | Waveform, words aligned under it, and a strip of video frames. Drag across the waveform to flag a voice region (pronunciation, pacing, timbre, artifact) or across the frames to flag the face (lip-sync, glitch, lighting, gaze). **Synthesize** plays the turn through the current voice. | `POST /api/inspect/:slug/flags` appends to `review/flags.jsonl` and logs an `inspect_flag` event |
| Loss and voice quality | Curves per checkpoint, with the loaded step marked. | `../voice/checkpoints/<run>/training_args.json` when a checkpoint has been downloaded; for `prannay`, realistic fixtures until then (the header says `fixture` or `checkpoints`) |
| Distill queue | Jobs queued from selected flags, with progress and the checkpoint they start from. | `POST /api/inspect/:slug/distill` appends to `review/distill-jobs.jsonl` |

The distill queue records intent. It does not start a Modal job; training still runs through `make train` in `../voice`.

## Repo layout

```
engram/
  server/            Hono API. One file per route in routes/, clients in lib/.
  web/               Vite + React 19. pages/EngramPage.tsx is the stage, pages/InspectPage.tsx is Inspect.
  shared/types.ts    Wire types shared by both sides.
  engrams/<slug>/    One folder per person: engram.json, context/, photos/, video/.
  pipelines/video/   BFL FLUX pipeline: photos -> portrait -> idle and talk loops.
  review/            Everything Prannay reviews, served at /review/.
  docs/              CONTRACTS.md (routes and ownership), adding-an-engram.md, img/.
../voice/            LFM2.5-Audio fine-tune and the Modal TTS service (Makefile, modal_app.py, serve.py).
```

## Next

- [Adding an engram](docs/adding-an-engram.md): the folder contract, recording and fine-tuning a voice, and building a face.
- [API reference](docs/api.md): every route with request and response shapes.
- [Video pipeline](docs/video-pipeline.md) and [Voice pipeline](docs/voice-pipeline.md): how the face and the voice are made, step by step.
- [Contracts](docs/CONTRACTS.md): routes, event types, and which workstream owns which file.
