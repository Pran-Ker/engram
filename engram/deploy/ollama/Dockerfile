# Ollama with the Liquid brain and the embedding model baked into the image,
# so the service answers on first boot with no volume and no pull step.
FROM ollama/ollama:latest
ENV OLLAMA_HOST=[::]:11434
ENV OLLAMA_KEEP_ALIVE=24h
RUN (ollama serve > /tmp/serve.log 2>&1 &) && sleep 5 \
 && ollama pull all-minilm \
 && ollama pull hf.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF:Q4_K_M \
 && pkill ollama || true
EXPOSE 11434
