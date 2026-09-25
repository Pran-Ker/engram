"""TTS web service for Engram: LFM2.5-Audio-1.5B on Modal, fine-tuned voice when a run exists.

Deploy:   make deploy            (uv run modal deploy serve.py, then writes .tts-url)
          env: ENGRAM_TTS_GPU (L4), ENGRAM_TTS_WARM (3 warm containers), ENGRAM_TTS_APP (engram-tts, for a side-by-side test)
Routes:   POST {url}/tts        {text, run, system_prompt}  -> audio/wav 24 kHz PCM16, header x-voice-provider
          POST {url}/tts/stream {text, run, system_prompt}  -> chunked raw PCM16 LE mono 24 kHz, first chunk ~0.7 s in
          GET  {url}/health                                 -> {loaded, provider, run_exists, gpu, ...}
Speed:    generation is one autoregressive step per 80 ms audio frame; the step is launch-bound, so a bigger GPU
          does not help (H100 == L4) and threads on one GPU fight the GIL (3 parallel = 3x slower each).
          So: one generation at a time per container, several warm containers, and causal-conv1d compiled in
          (without it transformers falls back to the slow reference conv path).
Cost:     ENGRAM_TTS_WARM L4 containers at ~$0.80/h each while deployed. `make tts-stop` when done.
Runs:     a background watcher polls the voice-ckpt volume; the moment /ckpt/<run>/final lands it is loaded,
          so the first request after training does not pay the load.
"""
from __future__ import annotations

import io
import json
import os
import sys
import threading
import time
from pathlib import Path

import modal

from modal_app import BASE_MODEL, CKPT, VOLUMES, ckpt_vol, hf_vol

APP_NAME = os.environ.get("ENGRAM_TTS_APP", "engram-tts")
DEFAULT_RUN = "prannay-v1"
BASE_PROMPT = "Perform TTS. Use the US male voice."
GPU = os.environ.get("ENGRAM_TTS_GPU", "L4")
WARM = int(os.environ.get("ENGRAM_TTS_WARM", "3"))
STAT_TTL_S = 30
TOKENS_PER_WORD = 40
MIN_TOKENS = 160
MAX_TOKENS = 1024
FRAME_SAMPLES = 1920
FIRST_CHUNK_FRAMES = 8
CHUNK_FRAMES = 12
HOLD_FRAMES = 2
URL_FILE = Path(__file__).resolve().parent / ".tts-url"

app = modal.App(APP_NAME)
serve_image = (
    modal.Image.from_registry("nvidia/cuda:13.0.0-devel-ubuntu22.04", add_python="3.12")
    .apt_install("ffmpeg", "libsndfile1", "git", "build-essential", "ninja-build")
    .pip_install("liquid-audio==1.3.0", "soundfile>=0.13", "fastapi[standard]>=0.115")
    .env({"HF_HOME": "/hf", "TOKENIZERS_PARALLELISM": "false", "MAX_JOBS": "16", "CC": "gcc", "CXX": "g++"})
    .pip_install("causal-conv1d>=1.5")
    .env({"ENGRAM_TTS_APP": APP_NAME, "ENGRAM_TTS_GPU": GPU, "ENGRAM_TTS_WARM": str(WARM)})
    .add_local_python_source("modal_app")
)


def _has_causal_conv1d() -> bool:
    try:
        import causal_conv1d  # noqa: F401
        return True
    except Exception:
        return False


def _pcm16(x) -> bytes:
    import numpy as np

    return (np.clip(x, -1, 1) * 32767).astype("<i2").tobytes()


def token_budget(text: str) -> int:
    words = max(1, len(text.split()))
    return min(MAX_TOKENS, max(MIN_TOKENS, TOKENS_PER_WORD * words))


@app.cls(
    image=serve_image,
    gpu=GPU,
    volumes=VOLUMES,
    min_containers=WARM,
    max_containers=WARM + 2,
    scaledown_window=900,
    timeout=600,
    startup_timeout=1200,
)
@modal.concurrent(max_inputs=2, target_inputs=1)
class TTS:
    @modal.enter()
    def load(self):
        import torch

        t0 = time.time()
        torch.backends.cuda.matmul.allow_tf32 = True
        self.load_lock = threading.Lock()
        self.gen_lock = threading.Lock()
        self.loaded: dict[str, tuple] = {}
        self.run_seen: dict[str, tuple[float, bool]] = {}
        self.load_seconds: dict[str, float] = {}
        self.started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self._load("base")
        hf_vol.commit()
        self._warm()
        threading.Thread(target=self._watch_runs, daemon=True).start()
        print(f"[enter] base ready on {GPU} in {time.time() - t0:.1f}s", flush=True)

    def _source(self, run: str):
        return BASE_MODEL if run == "base" else CKPT / run / "final"

    def _load(self, run: str):
        from liquid_audio import LFM2AudioModel, LFM2AudioProcessor

        with self.load_lock:
            if run in self.loaded:
                return self.loaded[run]
            t0 = time.time()
            src = self._source(run)
            processor = LFM2AudioProcessor.from_pretrained(src, device="cuda").eval()
            model = LFM2AudioModel.from_pretrained(src, device="cuda").eval()
            self.loaded[run] = (processor, model)
            self.load_seconds[run] = round(time.time() - t0, 1)
            print(f"[load] {run} <- {src} in {self.load_seconds[run]}s", flush=True)
            return self.loaded[run]

    def _warm(self):
        t0 = time.time()
        self._synth("base", "Hey, this is Prannay.", BASE_PROMPT)
        print(f"[warm] cuda kernels ready in {time.time() - t0:.1f}s", flush=True)

    def _watch_runs(self):
        while True:
            try:
                if self._run_exists(DEFAULT_RUN) and DEFAULT_RUN not in self.loaded:
                    self._load(DEFAULT_RUN)
                    prompt = self._resolve(DEFAULT_RUN, None)[1]
                    self._synth(DEFAULT_RUN, "Hey, this is Prannay.", prompt)
                    print(f"[watch] {DEFAULT_RUN} live", flush=True)
            except Exception as e:
                print(f"[watch] {e!r}", flush=True)
            time.sleep(STAT_TTL_S)

    def _run_exists(self, run: str) -> bool:
        if run == "base":
            return True
        now = time.time()
        seen = self.run_seen.get(run)
        if seen and now - seen[0] < STAT_TTL_S:
            return seen[1]
        ckpt_vol.reload()
        ok = (CKPT / run / "final" / "model.safetensors").exists()
        self.run_seen[run] = (now, ok)
        return ok

    def _resolve(self, run: str, system_prompt: str | None) -> tuple[str, str]:
        if run != "base" and self._run_exists(run):
            args = CKPT / run / "training_args.json"
            trained_prompt = json.loads(args.read_text())["system_prompt"] if args.exists() else system_prompt
            return run, system_prompt or trained_prompt or BASE_PROMPT
        return "base", BASE_PROMPT

    def _frames(self, run: str, text: str, prompt: str):
        from liquid_audio import ChatState

        processor, model = self._load(run)
        chat = ChatState(processor)
        chat.new_turn("system"); chat.add_text(prompt); chat.end_turn()
        chat.new_turn("user"); chat.add_text(text); chat.end_turn()
        chat.new_turn("assistant")
        for t in model.generate_sequential(**chat, max_new_tokens=token_budget(text), audio_temperature=0.8, audio_top_k=64):
            if t.numel() <= 1:
                continue
            if int(t[0]) == 2048:
                break
            yield t

    def _decode(self, run: str, frames: list) -> "np.ndarray":
        import torch

        processor, _ = self._load(run)
        codes = torch.stack(frames, 1).unsqueeze(0).clamp(0, 2047)
        return processor.decode(codes).cpu()[0].float().numpy()

    def _synth(self, run: str, text: str, prompt: str) -> bytes:
        import soundfile as sf

        frames = list(self._frames(run, text, prompt))
        if not frames:
            raise RuntimeError(f"no audio generated for {text!r}")
        buf = io.BytesIO()
        sf.write(buf, self._decode(run, frames), 24_000, format="WAV", subtype="PCM_16")
        return buf.getvalue()

    def _synth_stream(self, run: str, text: str, prompt: str):
        import numpy as np

        frames: list = []
        emitted = 0
        next_at = FIRST_CHUNK_FRAMES
        with self.gen_lock:
            for t in self._frames(run, text, prompt):
                frames.append(t)
                if len(frames) < next_at:
                    continue
                pcm = self._decode(run, frames)
                safe = len(pcm) - HOLD_FRAMES * FRAME_SAMPLES
                if safe > emitted:
                    yield _pcm16(pcm[emitted:safe])
                    emitted = safe
                next_at = len(frames) + CHUNK_FRAMES
            if not frames:
                raise RuntimeError(f"no audio generated for {text!r}")
            pcm = self._decode(run, frames)
        if len(pcm) > emitted:
            yield _pcm16(pcm[emitted:])

    @modal.asgi_app(label=APP_NAME)
    def web(self):
        from fastapi import FastAPI, HTTPException
        from fastapi.responses import Response

        api = FastAPI(title=APP_NAME)

        @api.get("/health")
        def health(run: str = DEFAULT_RUN):
            exists = self._run_exists(run)
            return {
                "loaded": sorted(self.loaded),
                "provider": f"modal:{run}" if exists else "modal:base",
                "run": run,
                "run_exists": exists,
                "gpu": GPU,
                "warm_containers": WARM,
                "causal_conv1d": _has_causal_conv1d(),
                "load_seconds": self.load_seconds,
                "started": self.started,
                "base_model": BASE_MODEL,
            }

        @api.post("/tts/stream")
        def tts_stream(body: dict):
            from fastapi.responses import StreamingResponse

            text = str(body.get("text", "")).strip()
            if not text:
                raise HTTPException(400, "text is required")
            requested = str(body.get("run") or DEFAULT_RUN)
            run, prompt = self._resolve(requested, body.get("system_prompt"))
            t0 = time.time()

            def chunks():
                first = None
                total = 0
                for chunk in self._synth_stream(run, text, prompt):
                    if first is None:
                        first = int((time.time() - t0) * 1000)
                    total += len(chunk)
                    yield chunk
                ms = int((time.time() - t0) * 1000)
                print(f"[tts/stream] {run} first {first}ms total {ms}ms {total / 2 / 24_000:.1f}s audio: {text}", flush=True)

            return StreamingResponse(
                chunks(),
                media_type="audio/pcm",
                headers={
                    "x-voice-provider": f"modal:{run}",
                    "x-voice-requested": requested,
                    "x-voice-rate": "24000",
                    "x-voice-format": "s16le mono",
                    "x-voice-gpu": GPU,
                    "cache-control": "no-store",
                },
            )

        @api.post("/tts")
        def tts(body: dict):
            text = str(body.get("text", "")).strip()
            if not text:
                raise HTTPException(400, "text is required")
            requested = str(body.get("run") or DEFAULT_RUN)
            run, prompt = self._resolve(requested, body.get("system_prompt"))
            t0 = time.time()
            with self.gen_lock:
                queued = int((time.time() - t0) * 1000)
                wav = self._synth(run, text, prompt)
            ms = int((time.time() - t0) * 1000)
            seconds = (len(wav) - 44) / 2 / 24_000
            print(f"[tts] {run} {ms}ms (queued {queued}ms) {seconds:.1f}s audio: {text}", flush=True)
            return Response(
                content=wav,
                media_type="audio/wav",
                headers={
                    "x-voice-provider": f"modal:{run}",
                    "x-voice-requested": requested,
                    "x-voice-ms": str(ms),
                    "x-voice-queued-ms": str(queued),
                    "x-voice-seconds": f"{seconds:.2f}",
                    "x-voice-gpu": GPU,
                    "cache-control": "no-store",
                },
            )

        return api


def write_url() -> str:
    url = modal.Cls.from_name(APP_NAME, "TTS")().web.get_web_url()
    URL_FILE.write_text(url + "\n")
    print(url)
    return url


if __name__ == "__main__" and sys.argv[1:] == ["url"]:
    write_url()
