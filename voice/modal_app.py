"""Fine-tune LiquidAI/LFM2.5-Audio-1.5B on one speaker's voice, on Modal.

Stages (pick with --stage):
  check       list what is on the volumes (CPU, free)
  preprocess  tokenize data/<dataset>/clean with Liquid's LFM2AudioChatMapper (L4)
  train       full fine-tune with liquid_audio.trainer.Trainer on an A100-80GB, assemble a loadable checkpoint
  synth       generate wavs from a finished run (L4) and save them to ./samples/<run>/
  all         preprocess -> train -> synth

Volumes:
  voice-data      /data/<dataset>/clean/{*.wav,manifest.jsonl}   (uploaded with `make upload`)
                  /data/<dataset>/preprocessed/{train,val}
  voice-ckpt      /ckpt/<run>/final   (model + tokenizer + Mimi + detokenizer: loads with from_pretrained(Path))
  voice-hf-cache  /hf                 (base model snapshot, downloaded once)

Cost anchor (Modal list prices): A100-80GB ≈ $2.50/h. One hour of audio for 8 epochs is roughly 40-60 min of A100 time.
"""
from __future__ import annotations

import json
import math
import os
import shutil
import time
from pathlib import Path

import modal

BASE_MODEL = "LiquidAI/LFM2.5-Audio-1.5B"
SYSTEM_PROMPT = "Perform TTS. Use Prannay's voice."
DEFAULT_TEXTS = [
    "Hey, this is Prannay. I'm testing whether the fine-tuned model actually sounds like me.",
    "Post-training is where the leverage is right now. Program synthesis will define the next decade.",
    "Can you send me the deck before the meeting on Thursday? I want to read it on the train.",
    "We shipped it at four in the morning, and honestly, it just worked.",
    "The quick brown fox jumps over the lazy dog.",
]

app = modal.App("voice-finetune")

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg", "libsndfile1", "git")
    .pip_install("liquid-audio==1.3.0", "soundfile>=0.13", "hf_transfer")
    .env({"HF_HOME": "/hf", "HF_HUB_ENABLE_HF_TRANSFER": "1", "TOKENIZERS_PARALLELISM": "false"})
)

data_vol = modal.Volume.from_name("voice-data", create_if_missing=True)
ckpt_vol = modal.Volume.from_name("voice-ckpt", create_if_missing=True)
hf_vol = modal.Volume.from_name("voice-hf-cache", create_if_missing=True)
VOLUMES = {"/data": data_vol, "/ckpt": ckpt_vol, "/hf": hf_vol}

DATA, CKPT = Path("/data"), Path("/ckpt")


def _stamp(t0: float) -> str:
    m, s = divmod(int(time.time() - t0), 60)
    return f"[{m:02d}:{s:02d}]"


def _read_manifest(dataset: str) -> list[dict]:
    path = DATA / dataset / "clean" / "manifest.jsonl"
    if not path.exists():
        raise FileNotFoundError(f"{path} missing — run `make upload DATASET={dataset}` first")
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


# --------------------------------------------------------------------------- check
@app.function(image=image, volumes=VOLUMES, timeout=300)
def check() -> str:
    lines = []
    for ds in sorted(p for p in DATA.iterdir() if p.is_dir()):
        man = ds / "clean" / "manifest.jsonl"
        n = len(man.read_text().splitlines()) if man.exists() else 0
        pre = [p.name for p in (ds / "preprocessed").iterdir()] if (ds / "preprocessed").exists() else []
        lines.append(f"dataset {ds.name}: {n} clean clips, preprocessed={pre}")
    for run in sorted(p for p in CKPT.iterdir() if p.is_dir()):
        final = (run / "final" / "model.safetensors").exists()
        args = run / "training_args.json"
        lines.append(f"run {run.name}: final={'yes' if final else 'no'} {args.read_text() if args.exists() else ''}")
    return "\n".join(lines) or "volumes are empty"


# --------------------------------------------------------------------------- preprocess
@app.function(image=image, gpu="L4", volumes=VOLUMES, timeout=60 * 60)
def preprocess(dataset: str, system_prompt: str, context_length: int) -> dict:
    import torch
    from liquid_audio import LFM2AudioProcessor
    from liquid_audio.data.mapper import LFM2AudioChatMapper
    from liquid_audio.data.preprocess import preprocess_dataset
    from liquid_audio.data.types import AudioSegment, ChatMessage, TextSegment

    t0 = time.time()
    data_vol.reload()
    rows = _read_manifest(dataset)
    clean = DATA / dataset / "clean"
    out = DATA / dataset / "preprocessed"
    if out.exists():
        shutil.rmtree(out)

    processor = LFM2AudioProcessor.from_pretrained(BASE_MODEL, device="cuda").eval()
    hf_vol.commit()
    mapper = LFM2AudioChatMapper(processor)
    print(f"{_stamp(t0)} processor ready; {len(rows)} rows; system prompt = {system_prompt!r}")

    class Messages:
        """Picklable iterable (datasets fingerprints the input with dill; a bare generator cannot be pickled)."""

        def __init__(self, split: str) -> None:
            self.rows = [r for r in rows if r["split"] == split]

        def __iter__(self):
            for r in self.rows:
                yield [
                    ChatMessage(role="system", content=[TextSegment(text=system_prompt)]),
                    ChatMessage(role="user", content=[TextSegment(text=r["text"])]),
                    ChatMessage(role="assistant", content=[AudioSegment(audio=(clean / r["file"]).read_bytes())]),
                ]

    counts = {}
    for split in ("train", "val"):
        n = sum(r["split"] == split for r in rows)
        if n == 0:
            counts[split] = 0
            continue
        with torch.no_grad():
            preprocess_dataset(data=Messages(split), output_path=out / split, mapper=mapper, max_context_length=context_length)
        from datasets import load_from_disk
        counts[split] = len(load_from_disk(out / split))
        print(f"{_stamp(t0)} {split}: {counts[split]}/{n} samples kept (context_length={context_length})")

    (out / "meta.json").write_text(json.dumps({"system_prompt": system_prompt, "context_length": context_length, **counts}))
    data_vol.commit()
    return counts


# --------------------------------------------------------------------------- train
@app.function(image=image, gpu="A100-80GB", volumes=VOLUMES, timeout=4 * 60 * 60, cpu=8, memory=64 * 1024)
def train(dataset: str, run: str, epochs: int, batch_size: int, lr: float, max_steps: int) -> dict:
    from liquid_audio.data.dataloader import LFM2DataLoader
    from liquid_audio.trainer import Trainer
    from liquid_audio.utils import get_model_dir

    t0 = time.time()
    data_vol.reload()
    pre = DATA / dataset / "preprocessed"
    meta = json.loads((pre / "meta.json").read_text())
    context_length = meta["context_length"]

    train_data = LFM2DataLoader(dataset_path=str(pre / "train"), context_length=context_length)
    val_data = LFM2DataLoader(dataset_path=str(pre / "val"), context_length=context_length) if meta.get("val") else None
    n_train = len(train_data)
    steps_per_epoch = max(1, math.ceil(n_train / batch_size))
    total_steps = max_steps if max_steps > 0 else steps_per_epoch * epochs
    warmup = max(5, int(0.1 * total_steps))
    out_dir = CKPT / run
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    args = dict(dataset=dataset, run=run, base_model=BASE_MODEL, system_prompt=meta["system_prompt"], n_train=n_train,
                n_val=len(val_data) if val_data else 0, epochs=epochs, batch_size=batch_size, lr=lr,
                steps=total_steps, warmup=warmup, context_length=context_length, started=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    (out_dir / "training_args.json").write_text(json.dumps(args, indent=2))
    print(f"{_stamp(t0)} training {run}: {json.dumps(args)}")

    trainer = Trainer(
        model_id=BASE_MODEL,
        train_data=train_data,
        val_data=val_data,
        lr=lr,
        batch_size=batch_size,
        max_steps=total_steps,
        warmup_steps=warmup,
        dataloader_num_workers=4,
        logging_interval=5,
        save_interval=max(steps_per_epoch * 2, 50),   # intermediate checkpoints (model+optimizer) every ~2 epochs
        val_interval=steps_per_epoch,
        output_dir=str(out_dir),
    )
    hf_vol.commit()
    trainer.train()

    # Make final/ self-contained so LFM2AudioModel/LFM2AudioProcessor.from_pretrained(Path) both work.
    final = out_dir / "final"
    snap = get_model_dir(BASE_MODEL)
    for name in ("config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json",
                 "chat_template.jinja", "tokenizer-e351c8d8-checkpoint125.safetensors"):
        if (snap / name).exists():
            shutil.copy(snap / name, final / name)
    if (snap / "audio_detokenizer").exists():
        shutil.copytree(snap / "audio_detokenizer", final / "audio_detokenizer", dirs_exist_ok=True)
    shutil.rmtree(out_dir / "checkpoints", ignore_errors=True)  # optimizer states: ~12 GB each, not needed once final exists
    args["finished"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    args["train_minutes"] = round((time.time() - t0) / 60, 1)
    (out_dir / "training_args.json").write_text(json.dumps(args, indent=2))
    ckpt_vol.commit()
    print(f"{_stamp(t0)} done; checkpoint at /ckpt/{run}/final")
    return args


# --------------------------------------------------------------------------- synth
@app.function(image=image, gpu="L4", volumes=VOLUMES, timeout=30 * 60)
def synth(run: str, texts: list[str], system_prompt: str | None = None) -> list[tuple[str, bytes]]:
    import io
    import soundfile as sf
    import torch
    from liquid_audio import ChatState, LFM2AudioModel, LFM2AudioProcessor

    t0 = time.time()
    ckpt_vol.reload()
    if run == "base":
        src, prompt = BASE_MODEL, system_prompt or "Perform TTS. Use the US male voice."
    else:
        src = CKPT / run / "final"
        if not (src / "model.safetensors").exists():
            raise FileNotFoundError(f"no finished checkpoint at {src}")
        prompt = system_prompt or json.loads((CKPT / run / "training_args.json").read_text())["system_prompt"]

    processor = LFM2AudioProcessor.from_pretrained(src, device="cuda").eval()
    model = LFM2AudioModel.from_pretrained(src, device="cuda").eval()
    print(f"{_stamp(t0)} loaded {src}; prompt={prompt!r}")

    outputs = []
    for i, text in enumerate(texts):
        chat = ChatState(processor)
        chat.new_turn("system"); chat.add_text(prompt); chat.end_turn()
        chat.new_turn("user"); chat.add_text(text); chat.end_turn()
        chat.new_turn("assistant")
        audio_out: list[torch.Tensor] = []
        for t in model.generate_sequential(**chat, max_new_tokens=768, audio_temperature=0.8, audio_top_k=64):
            if t.numel() > 1:
                audio_out.append(t)
        if len(audio_out) < 2:
            print(f"  [{i}] no audio generated for: {text!r}")
            continue
        codes = torch.stack(audio_out[:-1], 1).unsqueeze(0)
        codes = codes.clamp(0, 2047)
        wav = processor.decode(codes).cpu()[0].float().numpy()
        buf = io.BytesIO()
        sf.write(buf, wav, 24_000, format="WAV", subtype="PCM_16")
        name = f"{i:02d}.wav"
        outputs.append((name, buf.getvalue()))
        print(f"{_stamp(t0)} [{i}] {len(wav)/24_000:.1f}s  {text}")
    # keep a copy next to the checkpoint too
    if run != "base":
        sdir = CKPT / run / "samples"
        sdir.mkdir(exist_ok=True)
        for name, b in outputs:
            (sdir / name).write_bytes(b)
        ckpt_vol.commit()
    return outputs


# --------------------------------------------------------------------------- entrypoint
@app.local_entrypoint()
def main(
    stage: str = "all",
    dataset: str = "prannay",
    run: str = "prannay-v1",
    epochs: int = 8,
    batch_size: int = 16,
    lr: float = 5e-5,
    context_length: int = 320,
    max_steps: int = 0,
    system_prompt: str = SYSTEM_PROMPT,
    text: str = "",
):
    if stage == "check":
        print(check.remote())
        return
    if stage in ("preprocess", "all"):
        print("preprocess:", preprocess.remote(dataset, system_prompt, context_length))
    if stage in ("train", "all"):
        print("train:", json.dumps(train.remote(dataset, run, epochs, batch_size, lr, max_steps), indent=2))
    if stage in ("synth", "all"):
        texts = [text] if text else DEFAULT_TEXTS
        local = Path(__file__).resolve().parent / "samples" / run
        local.mkdir(parents=True, exist_ok=True)
        if run == "base" and system_prompt == SYSTEM_PROMPT:
            # stock model: render every built-in voice so they can be compared (container stays warm across calls)
            voices = {"us-male": "US male", "us-female": "US female", "uk-male": "UK male", "uk-female": "UK female"}
            for tag, v in voices.items():
                outs = synth.remote(run, texts, f"Perform TTS. Use the {v} voice.")
                for name, b in outs:
                    (local / f"{tag}-{name}").write_bytes(b)
                print(f"synth: {tag}: {len(outs)} wav(s)")
        else:
            outs = synth.remote(run, texts, system_prompt if run == "base" else None)
            for name, b in outs:
                (local / name).write_bytes(b)
            print(f"synth: wrote {len(outs)} wav(s) to {local}")
        (local / "texts.json").write_text(json.dumps(texts, indent=2))
