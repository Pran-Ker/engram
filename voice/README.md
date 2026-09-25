# Voice personalization — LFM2.5-Audio-1.5B fine-tuned on Prannay

Goal: make Liquid's `LFM2.5-Audio-1.5B` speak in Prannay's voice, so the Engram demo (`../engram`) talks with his voice instead of a stock one.
Record on the Mac, train on Modal (A100-80GB, about an hour, a few dollars), serve from Modal (`serve.py`).

## Checklist

- [x] **Voice personalization taken up** (Sept 25 2026). Owner: Prannay + Claude. Pipeline lives in this folder.
- [x] Research: no zero-shot cloning in LFM2.5-Audio; voice = system prompt label; fine-tune via `liquid-audio` 1.3 `Trainer` (full fine-tune)
- [x] Recorder (`scripts/record.py`), free-talk splitter (`scripts/transcribe.py`, mlx-whisper), cleaner (`scripts/prepare_dataset.py`)
- [x] Modal app (`modal_app.py`): preprocess (L4) → train (A100-80GB) → synth (L4); volumes `voice-data`, `voice-ckpt`, `voice-hf-cache`
- [x] Reading prompts: `prompts/sentences.txt` (Paul Graham, *How to Do Great Work*, 733 lines ≈ 70 min)
- [x] Local deps installed (`uv sync`), mic detected
- [x] Modal smoke test with synthetic audio (`make smoke`) passes end to end (Sept 25: preprocess → 3 train steps → synth, all OK)
- [ ] **Prannay records** 45–90 min (`make record`, plus `make record-free` takes)
- [ ] `make prepare` reports ≥ 45 min clean audio
- [ ] `make upload && make all` → run `prannay-v1` (≈ 1 h on A100)
- [ ] Listen to `samples/prannay-v1/*.wav`; iterate (more data, more epochs) if needed
- [ ] `make deploy` so Engram's `/tts` uses `modal:prannay-v1`

## How it works (short)

The model turns text into Mimi audio tokens (8 codebooks, 12.5 frames/s); a frozen detokenizer turns tokens into 24 kHz audio.
Each training example is (`"Perform TTS. Use Prannay's voice."`, sentence text) → audio tokens of Prannay saying that sentence.
Full fine-tune of backbone + audio decoder + encoder + text embedder with `liquid_audio.trainer.Trainer`; the vocoder stays frozen.

## Recording

```bash
make devices                 # pick the mic index; use the same mic every session
make record DEVICE="MacBook Pro Microphone"   # guided, one sentence at a time, resumable (Enter=record, Enter=stop, Enter=keep, r=redo, p=play)
make record-free DEVICE="MacBook Pro Microphone"  # 5–10 min of free talk; repeat a few times
make transcribe              # whisper (local, mlx) → clips at pauses → appended to data/raw/manifest.jsonl; skim transcripts
make prepare                 # trim/normalize/24 kHz, 5 % val split, stats + readiness verdict → data/clean/
```

Rules that matter: quiet room, same mic and distance, no music or other voices, read exactly what is shown, 2–14 s per clip.
Target 45–90 min kept audio (≈ 400–800 clips). 20 min gives a rough first result.

## Training and listening

```bash
make upload                  # data/clean → Modal volume voice-data:/prannay/clean
make all                     # preprocess + train + synth, detached; logs in the Modal dashboard
make synth TEXT="..."        # more samples from the finished run → samples/prannay-v1/
make download                # optional: pull the 3 GB checkpoint to checkpoints/prannay-v1
```

Defaults: 8 epochs, batch 16, lr 5e-5, context 320 tokens, warmup 10 %. Override: `make train EPOCHS=12 RUN=prannay-v2`.
Compare against the stock voice with `uv run modal run modal_app.py --stage synth --run base`.

## Cost

A100-80GB ≈ $2.50/h on Modal. One hour of audio × 8 epochs ≈ 40–60 min of GPU → roughly $2–3 per training run, plus cents for preprocess/synth.
Balance: **$30 credits** on Sept 25 2026 (dashboard, https://modal.com/settings/usage; the CLI only reports spend). Budget: one full run ≈ $2–3, so about ten runs. Env vars in `~/.local/secrets` select workspace `shared-13706`; the personal profile is `hebbarpran`.

## Layout

```
modal_app.py          Modal stages: check / preprocess / train / synth / all
serve.py              Engram TTS web endpoint (owned by the Engram session)
scripts/record.py     guided + free-talk recorder (48 kHz mono WAV)
scripts/transcribe.py mlx-whisper transcription + splitting of free takes
scripts/prepare_dataset.py  ffmpeg clean-up, 24 kHz, split, stats
scripts/make_smoke_data.py  synthetic clips for `make smoke`
prompts/sentences.txt what to read
data/                 raw/ free/ clean/ (git-ignored)   samples/  checkpoints/ (git-ignored)
```

## Sources

- https://github.com/Liquid4All/liquid-audio (Trainer, LFM2AudioChatMapper, Jenny TTS example)
- https://huggingface.co/LiquidAI/LFM2.5-Audio-1.5B
- https://github.com/Liquid4All/cookbook/tree/main/examples/voice-assistant (Modal A100 fine-tune reference)

## Serving (serve.py)

`make deploy` puts `POST /tts` on Modal and writes the URL to `.tts-url`; the Engram API reads that file.
The endpoint serves `/ckpt/<run>/final` when it exists and the base voice otherwise, and says which in `x-voice-provider`.
A watcher thread polls the checkpoint volume every 30 s and preloads `prannay-v1` the moment training writes it.
Proven with `make smoke`: `POST /tts {"run":"smoke"}` answers `x-voice-provider: modal:smoke`.

Speed facts, measured 2026-09-25: generation is one autoregressive step per 80 ms audio frame and the step is
launch-bound, so about 1x real time (4.6 s of audio in 5.2 s) on an L4 **and** on an H100. Threads on one GPU
fight the GIL: three parallel requests took 16–22 s each instead of 5. So the service generates one sentence
at a time per container and keeps `ENGRAM_TTS_WARM` (3) L4 containers warm; the Engram API splits sentences
longer than 70 chars at a clause boundary and synthesizes the halves on two containers at once.
`make tts-stop` when not demoing: 3 × L4 ≈ $2.40/h.

Blocking `prannay-v1`: there are no recordings yet (`data/raw` is empty, no Instagram videos). Fifteen minutes of
`make record` (about 120 sentences) then `make prepare && make upload && make all` produces the run; the
service picks it up without a redeploy.
