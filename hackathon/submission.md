# Engram: hackathon submission copy

Paste into https://tokensand.com/horizonagentshack/submit. Limits in brackets.

## One-sentence description [300]  (271 chars)

Stand in front of a screen and ask Prannay a question out loud. His face answers in his voice about 1.5 seconds later, from 38 notes about him and a live web search, and every turn lands in a database the agent reads back instead of hauling its history around in context.

## Project description [1500]  (1410 chars)

Six photos from my camera roll went in at 11 this morning. By noon there was a face on a 1920 by 993 stage that looks up when you talk to it.

Engram is a person you can stand in front of and talk to. Press start, ask a question out loud, and about 1.5 seconds later I answer in my own voice, from a folder of 38 Markdown cards about me and, when the question needs fresh facts, a Nimble search that writes what it found back into the folder as a new card.

The agent keeps nothing in context that it can look up. Every turn, token latency, tool call and voice fallback goes to a RawTree table, lh_engram_events, 1,380 rows so far today. After a conversation the brain distills what it learned into new cards. The Inspect page reads the same table back to grade fine-tune runs and flag bad turns. Kill the session and the next one starts from the folder and the table, not from a transcript.

Liquid's LFM2.5-1.2B on Ollama is the brain. LFM2.5-Audio-1.5B on Modal is the voice, with a fine-tune on my own recordings queued behind it. Black Forest Labs' FLUX 2 Pro and Kontext made the portrait from those six photos, and FLUX 3 Video turned it into the idle and talking loops, 39 pipeline runs to get one I liked. Nimble is the live memory. RawTree is the long one.

One engram is one folder: engram.json, context/*.md, photos/, video/. Adding a person is adding a folder. Chinmay Hebbar and I built it today.

## Technical architecture [1200]  (1190 chars)

Two processes. A Hono API on :4100 with one file per route, and a Vite + React 19 stage on :4173 that proxies /api to it.

POST /chat streams SSE from LFM2.5-1.2B-Instruct on Ollama. It emits a sentence event the moment a boundary appears, so the client starts speech on sentence one while the model is still writing sentence three. First token lands in 330 to 540 ms.

POST /tts/stream returns chunked PCM16 at 24 kHz from LFM2.5-Audio-1.5B on Modal, three warm L4 containers. The server holds the first 0.4 to 1.6 s of audio before releasing and the client holds 0.7 s more, so a sentence plays gapless while Modal generates at 0.8x realtime. Provider chain: fine-tuned run, base voice, local say. Each fallback is logged.

context.ts serves the cards and turns a Nimble search into new cards under section live. events.ts buffers and flushes to RawTree, table lh_engram_events, never blocking the caller. inspect.ts reads that table for run grading and flags.

pipelines/video/build.ts: photos to FLUX 2 Pro portrait, Kontext cleanup, FLUX 3 Video i2v for idle.mp4 and talk.mp4. voice/: browser recorder, Modal fine-tune, serve.py. The contract for all of it is engram/docs/CONTRACTS.md.

## Setup instructions [1200]  (1056 chars)

You need Node 22, Ollama, ffmpeg, uv and the modal CLI. Keys sit in ~/.local/secrets and never in the repo: NIMBLE_API_KEY, BFL_API_KEY, RAWTREE_API_KEY, MODAL_TOKEN_ID, MODAL_TOKEN_SECRET. Source it before anything below.

ollama pull hf.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF:Q4_K_M

cd hackathon && npm install && npm run check
Four green lines means all four sponsors answer.

cd engram && npm install && npm run dev
API on :4100, stage on :4173. Open http://localhost:4173/e/prannay, press start, ask something.

Voice: cd voice && make deploy puts LFM2.5-Audio on Modal with three warm L4s, about $2.40 an hour. make tts-stop when you are done. Without Modal the stage falls back to the base voice and says so in the x-voice-provider header.

Face: cd engram && npm run video:build -- prannay rebuilds the portrait and loops from engrams/prannay/photos, about a dollar of BFL credit per run.

Another person: add engram/engrams/<slug>/ with engram.json, context/*.md and photos/, run the video build, reload. docs/adding-an-engram.md walks through it.

## Lessons learned [1200]  (1172 chars)

Voice and face went two different ways. LFM2.5-Audio has no zero-shot cloning: the voice is a label in the system prompt, so a new voice means a full fine-tune of backbone, encoder and audio decoder with the vocoder frozen. FLUX needed no training, only four reference photos and a prompt. One is a dataset problem, the other is a data hygiene problem.

The dataset: 45 to 90 minutes of clean audio, 400 to 800 clips between 1 and 14 s, same mic and distance, 24 kHz, read exactly what is on screen. We built a browser recorder with follow-along word highlighting because the terminal recorder lost takes. Training is the cheap part, about an hour on an A100 for $2 to $3. Recording is the long pole.

The hygiene: references frontal, sharp, face over 600 px, no phone, no second person. FLUX.2 drifted the backdrop to grey on half the candidates, so a Kontext pass forces #0b0b0c. The first talk clip zoomed in 19% over six seconds; a locked-off tripod line in the prompt fixed it. Chrome shows limited-range luma 28 as rgb(11), so the loop floor maps to 14, not 11, to match the page. 39 runs, five review rounds, PSNR above 46 dB at the loop seam, scale drift under 3%.

## Fixed fields

- Project name: Engram
- Team size: 2 people. Teammate: Chinmay Hebbar, 4chinmai@gmail.com
- Tools: Liquid AI, Tinybird, Black Forest Labs, Nimble, RawTree (add as missing tool), Claude Code (add as missing tool). Not Codex, not OpenAI.
- GitHub: https://github.com/Pran-Ker/engram (make public first)
- Additional links, one per line:
  https://github.com/Pran-Ker/engram/blob/main/engram/docs/CONTRACTS.md
  https://github.com/Pran-Ker/engram/blob/main/engram/README.md
  https://github.com/Pran-Ker/engram/blob/main/voice/README.md
- Screenshot: engram/docs/img/stage.jpg
- Still yours: demo video URL (required), working project URL (optional)
