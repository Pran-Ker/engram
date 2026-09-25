# Voice personalization pipeline: record on the Mac, train on Modal, synthesize on Modal.
# Run `make` with no target to see this list.
PY      := uv run python
DATASET ?= prannay
RUN     ?= prannay-v1
EPOCHS  ?= 8
TEXT    ?= Hey, this is Prannay. I'm testing whether the fine-tuned model actually sounds like me.

.DEFAULT_GOAL := help
help:
	@echo "make setup        install local deps (uv)"
	@echo "make devices      list microphones"
	@echo "make record       guided sentence recording  (resumable)"
	@echo "make record-free  record a long free-talk take"
	@echo "make transcribe   whisper + split free takes into clips"
	@echo "make prepare      clean/normalize/resample + train/val split + stats"
	@echo "make upload       push data/clean to the Modal volume        (DATASET=$(DATASET))"
	@echo "make preprocess   tokenize on Modal GPU                        (DATASET=$(DATASET))"
	@echo "make train        full fine-tune on an A100-80GB               (RUN=$(RUN) EPOCHS=$(EPOCHS))"
	@echo "make synth        generate samples/ from the fine-tuned model  (RUN=$(RUN) TEXT=...)"
	@echo "make all          preprocess + train + synth in one Modal run"
	@echo "make download     pull the final checkpoint to checkpoints/$(RUN)"
	@echo "make smoke        end-to-end pipeline test with synthetic audio (~cents)"
	@echo "make deploy       deploy the TTS web service (serve.py) and write .tts-url"
	@echo "make tts-stop     stop the TTS service (it costs ~$$0.80/h while up)"

setup:
	uv sync

devices:
	$(PY) scripts/record.py --list-devices

record:  # DEVICE=<index or name from make devices>, e.g. make record DEVICE="MacBook Pro Microphone"
	$(PY) scripts/record.py $(if $(DEVICE),--device "$(DEVICE)",)

record-free:
	$(PY) scripts/record.py --free $(if $(DEVICE),--device "$(DEVICE)",)

transcribe:
	$(PY) scripts/transcribe.py

prepare:
	$(PY) scripts/prepare_dataset.py

upload:
	uv run modal volume put --force voice-data data/clean /$(DATASET)/clean

preprocess:
	uv run modal run modal_app.py --stage preprocess --dataset $(DATASET)

train:
	uv run modal run --detach modal_app.py --stage train --dataset $(DATASET) --run $(RUN) --epochs $(EPOCHS)

synth:
	uv run modal run modal_app.py --stage synth --run $(RUN) --text "$(TEXT)"

all:
	uv run modal run --detach modal_app.py --stage all --dataset $(DATASET) --run $(RUN) --epochs $(EPOCHS)

download:
	mkdir -p checkpoints/$(RUN)
	uv run modal volume get --force voice-ckpt /$(RUN)/final checkpoints/$(RUN)

smoke:
	$(PY) scripts/make_smoke_data.py
	uv run modal volume put --force voice-data data/smoke/clean /smoke/clean
	uv run modal run modal_app.py --stage all --dataset smoke --run smoke --epochs 1 --max-steps 3 --batch-size 2

.PHONY: help setup devices record record-free transcribe prepare upload preprocess train synth all download smoke

clean-smoke:
	uv run modal volume rm -r voice-data /smoke || true
	uv run modal volume rm -r voice-ckpt /smoke || true
	rm -rf data/smoke samples/smoke

.PHONY: clean-smoke

deploy:
	uv run modal deploy serve.py
	uv run python serve.py url

tts-url:
	uv run python serve.py url

tts-stop:
	uv run modal app stop engram-tts

.PHONY: deploy tts-url tts-stop
