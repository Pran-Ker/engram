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

## Technical architecture [1200]  (1196 chars)

Engram is built from three parts: a brain, a voice, and a face.

The brain is a small Liquid language model that runs on the laptop, not in the cloud. When you ask a question, it reads a folder of short notes about Prannay. If the question needs fresh facts, it runs a quick web search through Nimble and saves what it found as a new note. Then it starts writing an answer.

The voice is a second Liquid model running on rented cloud graphics cards through Modal. The brain does not finish the whole answer before speaking. The moment one sentence is done, it goes to the voice and starts playing while the brain writes the next one. Each side holds back about a second of sound before playing, so speech never stutters even though the voice runs a little slower than real time. If the custom voice is down, it drops to a standard voice, then the computer's built-in one, and records which it used.

The face is a portrait and two short video loops, one idle and one talking, made from six photos by Black Forest Labs' image and video models.

Every turn is saved to a RawTree table instead of kept in the model's memory, so the next session starts from the notes and the table, not a transcript.

## Setup instructions [1200]  (1197 chars)

Install Node, Ollama, ffmpeg, uv and the Modal command line tool. The API keys live in a file at ~/.local/secrets, never in the project. Load that file first.

1. Download the brain:
ollama pull hf.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF:Q4_K_M

2. Check that all four sponsor services respond:
cd hackathon && npm install && npm run check
Four green lines means everything is connected.

3. Start the app:
cd engram && npm install && npm run dev
Open http://localhost:4173/e/prannay, press start, and ask a question out loud.

4. Voice (optional). This puts the voice model on Modal's cloud:
cd voice && make deploy
It keeps three graphics cards ready, which costs about $2.40 an hour, so shut it down when finished:
make tts-stop
Without this step the app still works, it just uses a standard voice instead of Prannay's.

5. Face (optional). This rebuilds the portrait and video loops from the photos folder, for about a dollar of Black Forest Labs credit:
cd engram && npm run video:build -- prannay

To add another person, create a folder for them with a settings file, a folder of notes, and a folder of photos. Run the face step and reload. The guide docs/adding-an-engram.md walks through it.

## Lessons learned [1200]  (1196 chars)

The voice and the face turned out to be opposite problems.

The voice model cannot learn a new voice from a short sample. To sound like Prannay it must be retrained on his recordings. The face model needed no training at all, only four good photos and a written description.

So the voice is a collecting problem. You need about an hour of clean recordings, cut into hundreds of short clips, same microphone, same distance, reading exactly what is on screen. Our first recording tool lost takes, so we built one in the browser that highlights each word as you read. Training is the cheap part, an hour and a few dollars of rented computing. Recording is what takes the time.

The face is a quality problem. The photos have to be sharp, facing the camera, no phone in hand, nobody else in frame. Half the generated portraits drifted toward a grey background, so we added a second pass that forces the exact dark color of the page. The first talking video slowly zoomed in; telling the model the camera was on a locked tripod fixed it. The browser showed the video's black slightly lighter than the page's, so we matched them by hand. It took 39 attempts and five review rounds to get one we liked.

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
