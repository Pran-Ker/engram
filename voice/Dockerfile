# Voice Studio recorder for Railway (or any Docker host). Stdlib Python + ffmpeg, no other dependencies.
# Attach a persistent volume at /data; every voice lives under /data/<slug>/.
FROM python:3.12-slim
# Debian's ffmpeg 5.1 and the 7.0 static release both abort on the silenceremove+areverse chain
# (Assertion best_input >= 0, ffmpeg_filter.c); BtbN's current master build does not.
RUN apt-get update && apt-get install -y --no-install-recommends curl xz-utils && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz | tar -xJ -C /tmp \
 && mv /tmp/ffmpeg-master-latest-linux64-gpl/bin/ffmpeg /usr/local/bin/ffmpeg && rm -rf /tmp/ffmpeg-master-latest-linux64-gpl \
 && ffmpeg -version | head -1
WORKDIR /app
COPY takes.py prepare.py finetune.py ./
COPY prompts/sentences.txt prompts/sentences.txt
COPY web/server.py web/index.html web/landing.html web/train.html web/
ENV VOICE_DATA_DIR=/data PYTHONUNBUFFERED=1 PORT=4300
EXPOSE 4300
CMD ["python", "web/server.py"]
