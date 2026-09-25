# Voice pipeline

Engram speaks with a copy of Liquid's `LFM2.5-Audio-1.5B` fine-tuned on one person's recordings. You record the person on a Mac, train and serve on Modal, and the Engram server streams one sentence at a time from the service to the stage. This page follows the audio from the microphone to the speaker.

The training and serving code lives in `../voice`. The Engram side is `server/routes/tts.ts` with `server/lib/tts-modal.ts` and `server/lib/tts-local.ts`, and the playback queue in `web/src/lib/audio.ts`.

As of September 25, 2026 there are no recordings yet: `../voice/data/raw` is empty, the `prannay-v1` run does not exist on Modal, and the service answers in the base voice (`x-voice-provider: modal:base`). Everything after the recording step is built and tested with `make smoke`. The path that unblocks the real voice is `make record` (or `make web`), `make prepare`, `make upload`, `make all`; the service picks the run up without a redeploy.

## How the pieces fit

```mermaid
flowchart TD
  subgraph mac["Mac: ../voice"]
    rec["scripts/record.py  (make record)<br/>web/server.py  (make web, browser recorder)"] --> raw["data/raw, data/free"]
    raw --> tr["scripts/transcribe.py"]
    tr --> prep["scripts/prepare_dataset.py"]
    prep --> clean["data/clean/*.wav + manifest.jsonl"]
  end
  clean -- "make upload" --> vdata[("volume voice-data<br/>/data/prannay/clean")]
  vdata -- "preprocess (L4)" --> pre["/data/prannay/preprocessed/{train,val}"]
  pre -- "train (A100-80GB)" --> ckpt[("volume voice-ckpt<br/>/ckpt/prannay-v1/final")]
  hf[("volume voice-hf-cache<br/>LiquidAI/LFM2.5-Audio-1.5B")] --> serve
  ckpt -- "watcher thread, every 30 s" --> serve["serve.py class TTS<br/>app engram-tts, 3 warm L4 (ENGRAM_TTS_WARM)<br/>one generation per container"]
  serve -- "POST /tts/stream -> PCM16 chunks" --> tts["server/routes/tts.ts"]
  serve -- "POST /tts -> wav" --> tts
  tts <--> cache[("review/tts-cache/<sha1>.wav")]
  tts -- "audio/pcm stream<br/>x-voice-provider" --> web["web/src/lib/audio.ts<br/>playback queue, 0.7 s lead"]
  tts -- "tts_done, tts_fallback" --> ev["POST /api/events<br/>RawTree lh_engram_events"]
  say["macOS say"] -. "dev-only fallback on /tts" .-> tts
```

**Figure 1.** Data flow from recording to playback. Solid arrows are the demo path, the dotted arrow is the local fallback, which only the whole-file route uses.

## How the model learns a voice

`LFM2.5-Audio` has no zero-shot voice cloning. The voice is selected by the system prompt, so fine-tuning teaches the model that `Perform TTS. Use Prannay's voice.` means his voice.

Each training example pairs that system prompt and a sentence with Mimi audio tokens of Prannay reading the sentence (8 codebooks at 12.5 frames per second). A frozen detokenizer turns tokens into 24 kHz audio. `modal_app.py` runs a full fine-tune with `liquid_audio.trainer.Trainer` from `liquid-audio==1.3.0`.

Defaults from `modal_app.py`:

| Setting | Value |
|---|---|
| Base model | `LiquidAI/LFM2.5-Audio-1.5B` |
| Epochs, batch size, learning rate | 8, 16, 5e-5 |
| Context length | 320 tokens |
| Warmup | 10% of steps, at least 5 |
| Validation | once per epoch |
| Intermediate checkpoints | every 2 epochs or 50 steps, deleted once `final/` exists (about 12 GB each) |

The trained `final/` folder is self-contained: `modal_app.py` copies the tokenizer, config, chat template, and `audio_detokenizer` from the base snapshot so `LFM2AudioModel.from_pretrained(Path)` loads it directly.

## Before you begin

1. Install the local tools in the voice folder:

   ```bash
   cd ../voice && make setup
   ```

2. Load the Modal token in every shell you use for training or serving:

   ```bash
   source ~/.local/secrets
   ```

   `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` select the `shared-13706` workspace.

3. Confirm `ffmpeg` is on your `PATH`. `scripts/prepare_dataset.py` and the Modal image both use it.

## Record

Record in a quiet room with the same microphone at the same distance every session. Read exactly what the recorder shows. Clips between 2 and 14 seconds train best. Aim for 45 to 90 minutes of kept audio (about 400 to 800 clips). Fifteen minutes (about 120 sentences) gives a rough first run.

1. List microphones and note the index of the one you will use:

   ```bash
   make devices
   ```

2. Record guided sentences from `prompts/sentences.txt` (734 lines, about 70 minutes of reading). The session is resumable:

   ```bash
   make record DEVICE=2
   ```

   Enter records, Enter again stops, Enter keeps the take, `r` redoes it, `p` plays it back.

   To record in the browser instead, start the recorder and open `http://127.0.0.1:4300`. It writes the same `data/raw/` layout, so the two can be mixed:

   ```bash
   make web
   ```

   `PORT` and `RAW_DIR` override the port and the output folder.

3. Optional: Record 5 to 10 minutes of free talk, and repeat a few times:

   ```bash
   make record-free DEVICE=2
   ```

4. Transcribe and split the free takes at pauses. Skim the transcripts afterwards:

   ```bash
   make transcribe
   ```

5. Trim, normalize, resample to 24 kHz, and split 5% into validation. The command prints stats and a readiness verdict:

   ```bash
   make prepare
   ```

   The result lands in `data/clean/` with a `manifest.jsonl` of `{file, text, split}` rows.

## Train on Modal

Modal runs three stages. `preprocess` tokenizes with `LFM2AudioChatMapper` on an L4, `train` fine-tunes on an A100-80GB, and `synth` renders sample sentences on an L4. `make all` chains them in one detached run.

1. Push the clean dataset to the `voice-data` volume:

   ```bash
   make upload
   ```

2. Run all three stages. The command returns at once and logs stream in the Modal dashboard:

   ```bash
   make all
   ```

   To run stages one at a time use `make preprocess`, `make train`, and `make synth`. To change the run name or epochs pass variables, for example `make train RUN=prannay-v2 EPOCHS=12`.

3. Listen to `samples/prannay-v1/*.wav`. Render more sentences with your own text:

   ```bash
   make synth TEXT="Post-training is where the leverage is right now."
   ```

4. Optional: Pull the checkpoint (about 3 GB) to `checkpoints/prannay-v1`. The Inspect page reads `checkpoints/*/training_args.json` when it exists:

   ```bash
   make download
   ```

To see what is on the volumes at any time, run the CPU-only check stage:

```bash
uv run modal run modal_app.py --stage check
```

It lists each dataset with its clip count and each run with whether `final/` exists.

To compare against the stock voice, render the same sentences from the base model:

```bash
uv run modal run modal_app.py --stage synth --run base
```

To test the whole pipeline for a few cents before recording, run `make smoke` (synthetic audio, 3 training steps) and `make clean-smoke` afterwards.

## Serve

`serve.py` deploys the Modal app `engram-tts` with three always-warm L4 containers, so the stage never waits for a cold start and three sentences can be synthesized at the same time.

1. Deploy the service and write its URL to `../voice/.tts-url`:

   ```bash
   make deploy
   ```

   This runs `uv run modal deploy serve.py` and then `uv run python serve.py url`. The Engram server reads `.tts-url` on every request, so a redeploy needs no restart. `make tts-url` rewrites the file without deploying.

2. Check that the service is up and which voice it will use:

   ```bash
   curl "$(cat ../voice/.tts-url)/health?run=prannay-v1"
   ```

   Response:

   ```json
   {"loaded":["base"],"provider":"modal:base","run":"prannay-v1","run_exists":false,"gpu":"L4","warm_containers":3,"causal_conv1d":true,"load_seconds":{"base":5.0},"started":"2026-09-25T21:07:55Z","base_model":"LiquidAI/LFM2.5-Audio-1.5B"}
   ```

   `provider` becomes `modal:prannay-v1` as soon as `/ckpt/prannay-v1/final/model.safetensors` appears on the volume. A watcher thread in every container checks the volume every 30 s (`STAT_TTL_S`), loads the run when it lands, and synthesizes one warm-up line, so the first real request after training does not pay for the load.

3. Stop the service when you are done demoing. Three L4 containers cost about $2.40 per hour while deployed:

   ```bash
   make tts-stop
   ```

Why three containers and not one bigger GPU: generation is one autoregressive step per 80 ms audio frame, and each step is launch-bound, so it runs at about 0.8 to 1x real time on an L4 and on an H100 alike (4.6 s of audio in 5.2 s). Threads on one GPU fight the GIL, so three parallel requests on one container took 16 to 22 s each instead of 5. The service therefore holds a lock so each container generates one sentence at a time, and scales across containers instead. The image compiles `causal-conv1d` in, because without it transformers falls back to a slow reference convolution.

How the service behaves:

| Setting | Value |
|---|---|
| GPU, containers | `ENGRAM_TTS_GPU` (`L4`), `min_containers` = `ENGRAM_TTS_WARM` (`3`), `max_containers` = warm + 2, at most 2 inputs per container with 1 targeted, scale down after 900 s idle |
| Startup | loads the base model (about 5 s from the `voice-hf-cache` volume), synthesizes one line to warm the CUDA kernels, starts the watcher thread |
| Token budget | 40 audio tokens per word, at least 160, at most 1024 |
| Sampling | `audio_temperature=0.8`, `audio_top_k=64` |
| `POST /tts/stream` | `audio/pcm`, PCM16 LE mono 24 kHz. Decodes and sends after the first 8 frames (0.64 s of audio), then every 12 frames, always keeping the last 2 frames back for decoder context. Headers `x-voice-provider`, `x-voice-requested`, `x-voice-rate`, `x-voice-format`, `x-voice-gpu` |
| `POST /tts` | `audio/wav`, 24 kHz mono PCM16. Headers `x-voice-provider`, `x-voice-requested`, `x-voice-ms`, `x-voice-queued-ms` (time spent waiting for the container's lock), `x-voice-seconds`, `x-voice-gpu` |
| `GET /health?run=` | the JSON in step 2 |
| App name | `ENGRAM_TTS_APP` (`engram-tts`); set another name to deploy a second copy for a side-by-side test |

The service resolves the prompt in `_resolve`: a fine-tuned run uses the request's `system_prompt`, else the prompt stored in `training_args.json`. The base voice always uses `Perform TTS. Use the US male voice.`

## How the Engram server uses it

The stage asks `POST /api/engrams/:slug/tts/stream` first and plays the PCM as it arrives. If that route answers `503` before any audio, the browser retries the sentence on `POST /api/engrams/:slug/tts` and plays the whole wav. Both routes read `voice.run` and `voice.systemPrompt` from `engrams/<slug>/engram.json`. See [the API reference](api.md#voice) for the route contracts.

Test the stream from the repo root while the dev server is running:

```bash
curl -s -D - -o /tmp/hello.pcm -X POST http://localhost:4100/api/engrams/prannay/tts/stream \
  -H 'Content-Type: application/json' \
  -d '{"text":"Hey, this is Prannay. Thanks for coming by."}' | grep -i x-voice
```

Response headers:

```text
x-voice-cache: hit
x-voice-format: s16le mono
x-voice-provider: modal:base
x-voice-rate: 24000
```

Details that matter on stage:

- **Head start.** Modal generates slightly slower than real time, so the server holds the first `min(1.6 s, 0.15 × estimated duration − 0.6 s)` of a streamed sentence before releasing anything (estimate: 0.08 s per character; nothing is held under about 50 characters). The browser adds a 0.7 s lead before the first chunk plays and re-buffers 0.4 s if it ever runs dry. Together they keep a 12 s sentence gapless.
- **Latency.** Measured on the stage with the base voice: the first chunk leaves Modal about 1.0 to 1.5 s after the request, the first spoken word lands about 3.3 s after the question ends for a new sentence, and about 1.4 s when the sentence is in the cache.
- **Cache.** The key is `sha1("<run>\n<text>")`. Both routes read and write `review/tts-cache/<key>.wav` plus a `.json` sidecar with the provider; the stream route tees its chunks into the same file. Results from `local:say` are written but never read back, so a dev fallback cannot leak into the demo. The Inspect page plays turns straight from this cache.
- **Long sentences on `/tts`.** Over 70 characters, the text is split once at a clause boundary near the middle and the halves are synthesized on two containers at once, then joined with a 140 ms gap. `x-voice-parts` says whether that happened.
- **URL.** `ENGRAM_TTS_URL` overrides `../voice/.tts-url`. Without either, both routes fail with `no TTS url: set ENGRAM_TTS_URL or run make deploy in ../voice`.
- **Timeout.** 45 seconds per Modal call, 5 seconds for health.
- **Events.** Every synthesis posts a `tts_done` row to `ENGRAM_EVENTS_URL` (default `http://localhost:4100/api/events`): `meta.firstMs` and `meta.stream: true` from the stream route, `meta.modalMs` and `meta.parts` from the wav route. Every fallback posts a `tts_fallback` row with the reason in `text`. The Inspect page reads these from RawTree.

### Fallback chain

| Order | Provider | When | What gets logged |
|---|---|---|---|
| 1 | `modal:prannay-v1` over `/tts/stream` | the run's `final/model.safetensors` exists on `voice-ckpt` | `tts_done` |
| 2 | `modal:base` over `/tts/stream` | Modal answered but the run is missing, so `serve.py` used the base voice | `tts_fallback` with `run prannay-v1 not on Modal yet`, then `tts_done` |
| 3 | the same two voices over `/tts` | the stream route returned `503 stream unavailable` before any audio; the browser retries | as in rows 1 and 2, plus `meta.parts` |
| 4 | `local:say` | `/tts` could not reach Modal, on macOS, and `ENGRAM_TTS_LOCAL` is not `0` | `tts_fallback` with the Modal error, then `tts_done`; never served from the cache |
| 5 | none | Modal failed and local is unavailable or disabled | `503 {"error":"no TTS provider available: Modal unreachable and local say disabled"}`; the transcript shows the sentence in grey with "no voice for this, shown as text" |

Set `ENGRAM_TTS_LOCAL=0` on the stage machine so a Modal outage surfaces as text instead of a stranger's voice.

![The stage while the engram speaks: status reads SPEAKING, orange bars on the voice bar, and the current sentence in orange under the pinned question](img/stage-speaking.jpg)

**Figure 2.** What the audience sees while a streamed sentence plays: the voice bar follows the playback analyser and the transcript highlights the sentence being spoken.

## Cost anchors

Modal list prices as noted in `modal_app.py`, `serve.py`, and the `Makefile`:

| Stage | GPU | Cost |
|---|---|---|
| `preprocess`, `synth`, `check` | L4, L4, CPU | cents per run |
| `train` | A100-80GB at about $2.50 per hour | one hour of audio for 8 epochs takes 40 to 60 minutes, about $2 to $3 per run |
| `smoke` | L4 and A100-80GB for 3 steps | cents |
| serve (`engram-tts`) | 3 warm L4 containers at about $0.80 per hour each | about $2.40 per hour while deployed, so run `make tts-stop` after the demo |

Modal has no CLI for the credit balance. Check [the Modal usage page](https://modal.com/settings/usage).

## Files

| Path | Role |
|---|---|
| `../voice/modal_app.py` | Modal stages `check`, `preprocess`, `train`, `synth`, `all`, and the shared image and volumes |
| `../voice/serve.py` | Modal app `engram-tts`: class `TTS` with `POST /tts/stream`, `POST /tts`, `GET /health`, and the checkpoint watcher |
| `../voice/Makefile` | every command on this page |
| `../voice/.tts-url` | URL written by `make deploy`, read by the Engram server |
| `../voice/scripts/` | `record.py`, `transcribe.py`, `prepare_dataset.py`, `make_smoke_data.py` |
| `../voice/web/` | the browser recorder (`index.html`, `server.py`) behind `make web` |
| `../voice/prompts/sentences.txt` | 734 sentences to read, about 70 minutes |
| `server/routes/tts.ts` | Engram routes: stream hold, clause split, cache, fallback chain, events |
| `server/lib/tts-modal.ts`, `server/lib/tts-local.ts` | the Modal client (`modalTtsStream`, `modalTts`, `modalHealth`) and the macOS `say` fallback |
| `web/src/lib/audio.ts` | the browser playback queue: streamed PCM, whole wavs, the 0.7 s lead |
| `review/tts-cache/` | cached wavs keyed by `sha1(run\ntext)` |
