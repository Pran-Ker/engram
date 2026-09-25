import type { InspectCheckpoint, InspectCurvePoint, InspectRun, InspectTurn, InspectWord } from '../../shared/types.ts'

export function seeded(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hashText(text: string) {
  let h = 2166136261
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return h >>> 0
}

const RUN = {
  id: 'prannay-v1',
  baseModel: 'LiquidAI/LFM2.5-Audio-1.5B',
  gpu: 'A100-80GB',
  epochs: 8,
  steps: 2400,
  batchSize: 16,
  lr: 5e-5,
  warmup: 240,
  nTrain: 4800,
  nVal: 240,
  startedAt: '2026-09-24T21:12:40Z',
  finishedAt: '2026-09-25T00:41:07Z',
  trainMinutes: 208.4,
}

const CKPT_STEPS = [400, 800, 1200, 1600, 2000, 2400]

function trainLossAt(step: number, noise: () => number, drift: { value: number }) {
  const p = step / RUN.steps
  const base = 1.6 + 2.5 * Math.exp(-4.2 * p) + 0.18 * Math.exp(-40 * p)
  drift.value = drift.value * 0.72 + (noise() - 0.5) * 0.11
  const jitter = (noise() - 0.5) * 0.09 * (1 - 0.5 * p)
  return round(base + drift.value + jitter, 4)
}

function valLossAt(step: number, noise: () => number) {
  const p = step / RUN.steps
  const uptick = p > 0.86 ? (p - 0.86) * 1.4 : 0
  const base = 1.72 + 2.3 * Math.exp(-3.9 * p) + uptick
  return round(base + (noise() - 0.5) * 0.05, 4)
}

function speakerSimAt(step: number, noise: () => number) {
  const p = step / RUN.steps
  return round(0.41 + 0.42 * (1 - Math.exp(-3.1 * p)) / (1 - Math.exp(-3.1)) + (noise() - 0.5) * 0.012, 4)
}

function werAt(step: number, noise: () => number) {
  const p = step / RUN.steps
  return round(6.2 + 11.8 * Math.exp(-3.4 * p) * (1 - p) + (noise() - 0.5) * 0.3, 2)
}

export function fixtureCurve(): InspectCurvePoint[] {
  const noise = seeded(2401)
  const valNoise = seeded(77)
  const points: InspectCurvePoint[] = []
  const drift = { value: 0 }
  for (let step = 10; step <= RUN.steps; step += 10) {
    const point: InspectCurvePoint = { step, train: trainLossAt(step, noise, drift) }
    if (step % 300 === 0) point.val = valLossAt(step, valNoise)
    points.push(point)
  }
  return points
}

export function fixtureCheckpoints(): InspectCheckpoint[] {
  const noise = seeded(9001)
  const curve = fixtureCurve()
  const startMs = Date.parse(RUN.startedAt)
  const perStepMs = (RUN.trainMinutes * 60_000) / RUN.steps
  return CKPT_STEPS.map((step) => {
    const window = curve.filter((p) => p.step > step - 100 && p.step <= step)
    const trainLoss = round(window.reduce((a, p) => a + p.train, 0) / window.length, 4)
    return {
      step,
      epoch: Math.round((step / RUN.steps) * RUN.epochs),
      trainLoss,
      valLoss: valLossAt(step, seeded(77 + step)),
      speakerSim: speakerSimAt(step, noise),
      wer: werAt(step, noise),
      savedAt: new Date(startMs + step * perStepMs).toISOString(),
    }
  })
}

export function fixtureRun(engram: string): InspectRun {
  return {
    ...RUN,
    engram,
    status: 'done',
    currentStep: RUN.steps,
    checkpoints: fixtureCheckpoints(),
    curve: fixtureCurve(),
    source: 'fixture',
  }
}

const DEMO: { user: string; text: string; provider: string }[] = [
  { user: 'Hey Prannay, what are you working on right now?', text: "Honestly, this. A version of me you can stand in front of and talk to. Face, voice, memories, all of it running off small models.", provider: 'modal:prannay-v1' },
  { user: 'Why small models? Everyone else is scaling up.', text: "Because I want it to answer in under a second on one GPU. A 1.2B Liquid model with the right context beats a huge model that shows up two seconds late.", provider: 'modal:prannay-v1' },
  { user: 'Tell me about the REAL benchmark.', text: "We built deterministic replicas of eleven real websites and a hundred and twelve tasks. Frontier models topped out around forty one percent. It got into NeurIPS.", provider: 'modal:prannay-v1' },
  { user: 'What did you do at AGI Inc?', text: "Trained web agents with RL. GRPO, policy distillation from Gemini trajectories into DeepSeek. We got the agent to seventy six percent on OSWorld, which was the best number at the time.", provider: 'modal:prannay-v1' },
  { user: 'And Hexo Labs?', text: "Self improving research agents. SIA rewrites its own scaffold between generations and hit eighty point eight on GPQA Diamond with nobody touching it. It runs at Livermore now.", provider: 'modal:base' },
  { user: 'What are you building next?', text: "Still converging. I left in July to start a company and I'm raising a seed in SF. Pretty sure it's in the coding agent and program synthesis space.", provider: 'modal:prannay-v1' },
  { user: 'How is your voice being generated right now?', text: "LFM2.5 Audio, one and a half billion parameters, fine tuned on about forty minutes of me reading sentences. It runs on Modal and streams a sentence at a time.", provider: 'modal:prannay-v1' },
  { user: 'Does it actually sound like you?', text: "Closer every checkpoint. Speaker similarity is at point eight three. The pacing is still a little flat on longer sentences, which is what the inspect page is for.", provider: 'modal:prannay-v1' },
  { user: 'Where did you grow up?', text: "India. Did my undergrad at VIT in Vellore, then a summer at Stanford in twenty twenty four. Took convex optimization with Boyd, which was super fun.", provider: 'modal:prannay-v1' },
  { user: 'What is one opinion most people disagree with you on?', text: "That the interesting part of agents is not the model, it's the environment. If you can't replay the world deterministically you can't train on it.", provider: 'modal:prannay-v1' },
  { user: 'Who is Chinmay?', text: "My brother. We talk most days. He is the reason half my side projects ever got finished.", provider: 'modal:prannay-v1' },
  { user: 'What do you do when you are not working?', text: "Poker, mostly badly. Running around Palo Alto. And reading way too many papers on test time training.", provider: 'modal:prannay-v1' },
  { user: 'What would you tell someone starting in AI research today?', text: "Pick a benchmark you can move and ship something every week. Speed of execution matters more than polish early on.", provider: 'local:say' },
  { user: 'Thanks Prannay.', text: "Anytime. Come find the real me after, I'm somewhere near the coffee.", provider: 'modal:prannay-v1' },
]

export function layoutWords(text: string, durationMs: number): InspectWord[] {
  const words = text.split(/\s+/).filter(Boolean)
  const weights = words.map((w) => w.replace(/[^a-z0-9']/gi, '').length + 1.4 + (/[.,!?]$/.test(w) ? 1.6 : 0))
  const total = weights.reduce((a, b) => a + b, 0)
  const lead = 0.12
  const usable = durationMs / 1000 - lead - 0.18
  let cursor = lead
  return words.map((w, i) => {
    const span = (weights[i] / total) * usable
    const gap = /[.,!?]$/.test(w) ? span * 0.28 : span * 0.08
    const word = { text: w, start: round(cursor, 3), end: round(cursor + span - gap, 3) }
    cursor += span
    return word
  })
}

export function fixtureTurns(engram: string): InspectTurn[] {
  const noise = seeded(hashText(engram))
  const start = Date.parse('2026-09-25T14:02:10Z')
  let clock = start
  return DEMO.map((turn) => {
    const durationMs = Math.round(turn.text.length * (52 + noise() * 10) + 380)
    const latencyMs = Math.round(turn.provider === 'local:say' ? 1420 + noise() * 300 : 410 + noise() * 260)
    clock += 6_000 + noise() * 22_000
    const id = `t-${new Date(clock).toISOString().slice(11, 19).replace(/:/g, '')}-${hashText(turn.text).toString(16).slice(0, 4)}`
    const row: InspectTurn = {
      id,
      ts: new Date(clock).toISOString(),
      user: turn.user,
      text: turn.text,
      durationMs,
      latencyMs,
      provider: turn.provider,
      words: layoutWords(turn.text, durationMs),
      source: 'fixture',
    }
    clock += durationMs + latencyMs
    return row
  })
}

function round(n: number, digits: number) {
  const f = 10 ** digits
  return Math.round(n * f) / f
}
