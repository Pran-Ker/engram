# Long Horizon Agents Hackathon — Sept 25, 2026

Tokens& hackathon at DG717, San Francisco.

**Brief:** Ship long horizon agents that plan, act, observe, and self-correct across a full build cycle (spec, implementation, testing, iteration) without drowning in their own history. Use 3+ sponsor tools.

**Deadline:** project submission 4:30 PM PT at https://bit.ly/long-horizon-hack (one project per team, up to 4 people). Judging 4:45, finalists 6:00, awards 7:00. Everyone must be registered on Luma + AWS Builder (http://events.builder.aws.com/d/xdz2bp).

**Judging criteria**

| Criterion | Question |
|---|---|
| Autonomy | How well does the agent act on the web using real-time data without manual intervention? |
| Idea | Does it solve a meaningful problem or show real-world value? |
| Technical implementation | How well is the architecture built and implemented? |
| Tool use | Did it effectively use at least 3 sponsor tools? |
| Presentation | 3-minute live demo (not a slide deck). |

## Sponsors we're using

| Sponsor | What it is | Prize | Status |
|---|---|---|---|
| **Nimble** | Real-time web search / page extraction API for agents | 1st $1,000 + 10k credits, 2nd $500 + 5k | Account + key done, 5,000 trial requests |
| **Liquid AI** | Small LFM models that run locally on the laptop | Edge AI Kit (Orange Pi) + $250 | Running locally via Ollama |
| **Black Forest Labs** | FLUX image + video generation API | $1,000 API credits per track (Image, Video, Action) | Account + key done, $100 sponsor credits loaded |

Skipped: **Tinybird / RawTree** (private beta; the invite link https://tbrd.co/tokensand was failing for most people in Discord). Their prize pool is the biggest ($2k/$1k/$500) if someone gets in — go see them at the back.

Not viable: **FLUX Action** track. It's an open-weights 7B robotics model, not an API, and needs a 32 GB Linux GPU. Stick to FLUX Image or FLUX Video.

## Setup

Keys live in `~/.local/secrets` (never in this repo). Copy `hackathon/.env.example` if you need a local `.env`.

```bash
cd hackathon
npm install
source ~/.local/secrets
npm run check      # smoke-tests all three sponsors, ✅/❌ per line
```

### Nimble

- Console: https://online.nimbleway.com (Google login). Keys: Account → API Keys.
- Env var: `NIMBLE_API_KEY`. Free tier 5,000 requests/month, no card.
- SDK: `@nimble-way/nimble-js` (installed). Docs: https://docs.nimbleway.com/nimble-sdk/getting-started/quickstart

```js
import Nimble from "@nimble-way/nimble-js";
const nimble = new Nimble({ apiKey: process.env.NIMBLE_API_KEY });
const s = await nimble.search({ query: "…", max_results: 5 });
const page = await nimble.extract.run({ url: "https://…", render: true, formats: ["markdown"] });
```

- MCP for Claude Code (already registered on Prannay's machine):
  `claude mcp add --transport http nimble-mcp-server https://mcp.nimbleway.com/mcp --header "Authorization: Bearer $NIMBLE_API_KEY"`
- Cookbook ideas: https://www.nimbleway.com/cookbooks (fact-checker, live-docs Q&A, competitor monitor).

### Liquid AI

- No account or key. Models are open weights on https://huggingface.co/LiquidAI (LFM Open License, free under $10M revenue).
- Local via Ollama: `ollama pull hf.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF:Q4_K_M`, then hit `http://localhost:11434/api/chat` (OpenAI-compatible at `/v1/chat/completions`).
- The 8B MoE `ollama run lfm2.5` (tool calling, 128K ctx) needs Ollama ≥ 0.17; update the Ollama app if you want it.
- Fastest on Apple Silicon: `pip install mlx-lm && mlx_lm.server --model LiquidAI/LFM2.5-2.6B-MLX-8bit --port 8080`.
- API fallback: OpenRouter `liquid/lfm-2.5-*` models — Liquid's rep said to look for the `:free` ones.
- Vision: `LiquidAI/LFM2.5-VL-1.6B-GGUF` via `llama-server` or mlx-vlm. Docs: https://docs.liquid.ai

### Black Forest Labs (FLUX)

- Dashboard: https://dashboard.bfl.ai (Google login). Key: project → API → Keys. Env var: `BFL_API_KEY`.
- **Credits:** no free tier. BFL is giving **$100/account** this week — post your BFL account email in the Discord thread *"BFL Account Emails for credits"* under #black-forest-lab (Maanav from BFL processes them). Ours is loaded.
- Base URL `https://api.bfl.ai/v1`, header `x-key: $BFL_API_KEY`. Every call is async: POST → `{id, polling_url}` → GET the polling URL every ~2s until `status == "Ready"` → `result.sample` is a signed URL good for ~10 min.
- Image endpoints: `/flux-2-klein-4b` ($0.014, fast), `/flux-2-pro` ($0.03), `/flux-kontext-pro` (editing). Video: `POST /flux-3-video` with `mode: t2v|i2v|v2v`, `duration` 5–20s, `resolution: hd`, HD is $0.17/sec so a 5s clip ≈ $0.85.
- Open question in Discord: whether `flux-2-pro` is enabled for new accounts. `klein-4b` confirmed working.
- MCP: `claude mcp add --transport http FLUX https://mcp.bfl.ai` (OAuth via `/mcp`). Docs: https://docs.bfl.ai, full index https://docs.bfl.ai/llms.txt

## Discord

Server: Tokens& Hackathon. Channels under "Sept. 25 - Long Horizon Agents Hack": `#nimble`, `#liquidai`, `#black-forest-lab` (+ credits thread), `#tinybird`. Organizers: `#ask-organizers` (Fatima Lopez, Andy Tran). Sponsor reps in the room: Viviana (Liquid), Maanav / Freddy (BFL), bno (Tinybird).
