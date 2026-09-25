// Shared types between server and web. Server-owned; the web imports from here.

export type EngramManifest = {
  slug: string
  name: string
  tagline: string
  pronouns?: string
  voice: {
    provider: 'modal' | 'local'
    run: string             // Modal checkpoint run name, e.g. "prannay-v1"; "base" = LFM2.5-Audio base voice
    systemPrompt: string    // TTS system prompt, e.g. "Perform TTS. Use Prannay's voice."
  }
  video: {
    idle: string            // relative to engram dir, e.g. "video/idle.mp4"  (seamless loop, listening)
    talk: string            // "video/talk.mp4" (seamless loop, speaking)
    poster: string          // "video/poster.jpg" (first frame, shown before video loads)
  }
  brain: {
    model: string           // Ollama tag, e.g. "hf.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF:Q4_K_M"; an OpenRouter id when provider is "openrouter"
    persona: string         // one paragraph: who is speaking and how, prepended to the context bank
    provider?: 'ollama' | 'openrouter'   // default ollama. Direct mode uses openrouter (docs/direct-mode.md)
  }
  mode?: 'hyper' | 'direct' // default hyper: the hand-built path with a fine-tuned voice. direct: written by POST /api/direct/engrams
}

export type EngramSummary = Pick<EngramManifest, 'slug' | 'name' | 'tagline'> & {
  ready: { voice: boolean; video: boolean; context: boolean }
  cards: number
}

export type ContextSection = 'profile' | 'story' | 'work' | 'opinions' | 'voice' | 'memory' | 'live'

export type ContextCard = {
  id: string                 // filename without .md
  section: ContextSection
  title: string
  body: string               // markdown
  source: string             // where it came from: "~/Agent/prannay.md", a URL, "conversation 2026-09-25"
  updatedAt: string          // ISO
}

export type ChatMessage = { role: 'user' | 'assistant'; content: string }

// SSE events from POST /api/engrams/:slug/chat
export type ChatEvent =
  | { type: 'token'; text: string }
  | { type: 'sentence'; index: number; text: string }     // a complete sentence, ready for TTS
  | { type: 'context'; cards: string[]; live?: { query: string; urls: string[] } } // which cards / web hits were used
  | { type: 'done'; turnId: string; text: string; latencyMs: number }
  | { type: 'error'; message: string }

export type EventRow = {
  ts: string
  engram: string
  session: string
  turn?: string
  type: 'session_start' | 'user_utterance' | 'chat_first_token' | 'chat_done' | 'tts_done' | 'tts_fallback' | 'video_state' | 'context_web' | 'inspect_flag'
  ms?: number
  provider?: string
  chars?: number
  text?: string
  meta?: Record<string, unknown>
}

export type Health = {
  ollama: { ok: boolean; model?: string; detail?: string }
  tts: { ok: boolean; provider?: string; detail?: string }
  nimble: { ok: boolean; detail?: string }
  rawtree: { ok: boolean; detail?: string }
  bfl: { ok: boolean; detail?: string }
}

// Inspect page (fine-tune review). Appended by the inspect workstream.
export type InspectCheckpoint = {
  step: number
  epoch: number
  trainLoss: number
  valLoss: number
  speakerSim: number
  wer: number
  savedAt: string
  path?: string
}

export type InspectCurvePoint = { step: number; train: number; val?: number }

export type InspectRun = {
  id: string
  engram: string
  baseModel: string
  gpu: string
  status: 'running' | 'done'
  epochs: number
  steps: number
  currentStep: number
  batchSize: number
  lr: number
  warmup: number
  nTrain: number
  nVal: number
  startedAt: string
  finishedAt?: string
  trainMinutes?: number
  checkpoints: InspectCheckpoint[]
  curve: InspectCurvePoint[]
  source: 'fixture' | 'checkpoints'
}

export type InspectWord = { text: string; start: number; end: number }

export type InspectTurn = {
  id: string
  ts: string
  user: string
  text: string
  durationMs: number
  latencyMs: number
  provider: string
  words: InspectWord[]
  wav?: string
  source: 'rawtree' | 'fixture'
}

export type InspectFlagTrack = 'voice' | 'face'
export type InspectVoiceTag = 'pronunciation' | 'pacing' | 'timbre' | 'artifact'
export type InspectFaceTag = 'lip-sync' | 'glitch' | 'lighting' | 'gaze'

export type InspectFlag = {
  id: string
  engram: string
  turnId: string
  track: InspectFlagTrack
  start: number
  end: number
  tag: InspectVoiceTag | InspectFaceTag
  note: string
  ts: string
}

export type DistillJobStatus = 'queued' | 'preparing' | 'training' | 'evaluating' | 'done'

export type DistillJob = {
  id: string
  engram: string
  flagIds: string[]
  fromCheckpoint: number
  createdAt: string
  status: DistillJobStatus
  progress: number
  eta: string
  detail: string
}
