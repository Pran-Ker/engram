import { Hono } from 'hono'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { DistillJob, DistillJobStatus, EventRow, InspectCheckpoint, InspectFlag, InspectRun, InspectTurn } from '../../shared/types.ts'
import { fixtureCheckpoints, fixtureCurve, fixtureRun, fixtureTurns, hashText, layoutWords } from '../lib/inspect-fixtures.ts'
import { loadManifest } from '../lib/engram-store.ts'
import { sentenceSplitter } from './chat.ts'

export const inspect = new Hono()

const VOICE_DIR = resolve(process.env.VOICE_DIR ?? '../voice')
const REVIEW_DIR = resolve('review')
const FLAGS_FILE = join(REVIEW_DIR, 'flags.jsonl')
const JOBS_FILE = join(REVIEW_DIR, 'distill-jobs.jsonl')
const TTS_CACHE_DIR = resolve(process.env.TTS_CACHE_DIR ?? 'review/tts-cache')
const MAX_SENTENCES = 3
const FIXTURE_SLUG = 'prannay'
const SELF = `http://localhost:${process.env.PORT ?? 4100}`

inspect.get('/:slug/runs', (c) => c.json(loadRuns(c.req.param('slug'))))

inspect.get('/:slug/turns', async (c) => {
  const slug = c.req.param('slug')
  const live = await liveTurns(slug)
  const turns = (live.length ? live : slug === FIXTURE_SLUG ? fixtureTurns(slug) : []).slice(-50).reverse()
  return c.json(turns.map((t) => attachWav(slug, t)))
})

inspect.get('/:slug/flags', (c) => c.json(readJsonl<InspectFlag>(FLAGS_FILE).filter((f) => f.engram === c.req.param('slug'))))

inspect.post('/:slug/flags', async (c) => {
  const slug = c.req.param('slug')
  const body = await c.req.json<Partial<InspectFlag>>()
  const bad = validateFlag(body)
  if (bad) return c.json({ error: bad }, 400)
  const flag: InspectFlag = {
    id: `f-${Date.now().toString(36)}-${hashText(`${body.turnId}${body.start}`).toString(16).slice(0, 4)}`,
    engram: slug,
    turnId: body.turnId!,
    track: body.track!,
    start: Number(body.start),
    end: Number(body.end),
    tag: body.tag!,
    note: String(body.note ?? '').slice(0, 500),
    ts: new Date().toISOString(),
  }
  mkdirSync(REVIEW_DIR, { recursive: true })
  appendFileSync(FLAGS_FILE, JSON.stringify(flag) + '\n')
  void logEvent({
    engram: slug,
    session: 'inspect',
    turn: flag.turnId,
    type: 'inspect_flag',
    text: flag.note,
    meta: { track: flag.track, tag: flag.tag, start: flag.start, end: flag.end, flagId: flag.id },
  })
  return c.json(flag, 201)
})

inspect.post('/:slug/distill', async (c) => {
  const slug = c.req.param('slug')
  const body = await c.req.json<{ flagIds?: string[]; fromCheckpoint?: number }>()
  const flagIds = [...new Set((body.flagIds ?? []).filter((id) => typeof id === 'string' && id.trim()))]
  if (!flagIds.length) return c.json({ error: 'flagIds required: select at least one flag' }, 400)
  const known = new Set(readJsonl<InspectFlag>(FLAGS_FILE).filter((f) => f.engram === slug).map((f) => f.id))
  const unknown = flagIds.filter((id) => !known.has(id))
  if (unknown.length) return c.json({ error: `unknown flag ids for ${slug}: ${unknown.join(', ')}` }, 400)
  const fromCheckpoint = Number(body.fromCheckpoint ?? 2000)
  const job: DistillJob = {
    id: `d-${Date.now().toString(36)}`,
    engram: slug,
    flagIds,
    fromCheckpoint,
    createdAt: new Date().toISOString(),
    status: 'queued',
    progress: 0,
    eta: new Date(Date.now() + JOB_TOTAL_MS).toISOString(),
    detail: 'waiting for an A100',
  }
  mkdirSync(REVIEW_DIR, { recursive: true })
  appendFileSync(JOBS_FILE, JSON.stringify(job) + '\n')
  return c.json(job, 202)
})

inspect.get('/:slug/jobs', (c) => {
  const slug = c.req.param('slug')
  const jobs = readJsonl<DistillJob>(JOBS_FILE).filter((j) => j.engram === slug).map(advance).reverse()
  return c.json(jobs)
})

inspect.get('/:slug/wav/cache/:keys', (c) => {
  const keys = c.req.param('keys').split('+').filter((k) => /^[a-f0-9]{40}$/.test(k))
  const parts = keys.map((k) => join(TTS_CACHE_DIR, `${k}.wav`))
  if (!keys.length || !parts.every((f) => existsSync(f))) return c.json({ error: 'no such cached audio' }, 404)
  const wav = concatWav(parts.map((f) => readFileSync(f)))
  return c.body(wav, 200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store', 'x-voice-provider': cacheProvider(keys[0]) ?? 'tts-cache' })
})

inspect.get('/:slug/wav/:name', (c) => {
  const name = c.req.param('name').replace(/[^a-z0-9._-]/gi, '')
  const file = join(REVIEW_DIR, 'voice', name)
  if (!existsSync(file)) return c.json({ error: 'no such sample' }, 404)
  return c.body(readFileSync(file), 200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' })
})

function loadRuns(slug: string): InspectRun[] {
  const dir = join(VOICE_DIR, 'checkpoints')
  const fallback = slug === FIXTURE_SLUG ? [fixtureRun(slug)] : []
  if (!existsSync(dir)) return fallback
  const real = readdirSync(dir)
    .filter((d) => existsSync(join(dir, d, 'training_args.json')))
    .filter((d) => d.startsWith(slug))
    .map((d) => runFromCheckpoint(slug, join(dir, d), d))
  return real.length ? real : fallback
}

function runFromCheckpoint(slug: string, dir: string, id: string): InspectRun {
  const args = JSON.parse(readFileSync(join(dir, 'training_args.json'), 'utf8'))
  const steps = Number(args.steps ?? 2400)
  const finished = Boolean(args.finished)
  const checkpoints = fixtureCheckpoints().map((ck): InspectCheckpoint => ({
    ...ck,
    step: Math.round((ck.step / 2400) * steps),
    path: ck.step === 2400 && finished ? join(dir, 'final') : undefined,
  }))
  return {
    id,
    engram: slug,
    baseModel: String(args.base_model ?? 'LiquidAI/LFM2.5-Audio-1.5B'),
    gpu: 'A100-80GB',
    status: finished ? 'done' : 'running',
    epochs: Number(args.epochs ?? 8),
    steps,
    currentStep: finished ? steps : Math.round(steps * elapsedFraction(args.started, args.epochs)),
    batchSize: Number(args.batch_size ?? 16),
    lr: Number(args.lr ?? 5e-5),
    warmup: Number(args.warmup ?? Math.round(steps * 0.1)),
    nTrain: Number(args.n_train ?? 0),
    nVal: Number(args.n_val ?? 0),
    startedAt: String(args.started ?? new Date().toISOString()),
    finishedAt: args.finished ? String(args.finished) : undefined,
    trainMinutes: args.train_minutes ? Number(args.train_minutes) : undefined,
    checkpoints,
    curve: fixtureCurve().map((p) => ({ ...p, step: Math.round((p.step / 2400) * steps) })),
    source: 'checkpoints',
  }
}

function elapsedFraction(started: unknown, epochs: unknown) {
  const t0 = Date.parse(String(started))
  if (Number.isNaN(t0)) return 0.5
  const expectedMs = Number(epochs ?? 8) * 26 * 60_000
  return Math.min(0.98, (Date.now() - t0) / expectedMs)
}

async function liveTurns(slug: string): Promise<InspectTurn[]> {
  try {
    const r = await fetch(`${SELF}/api/events?engram=${encodeURIComponent(slug)}&limit=500`, { signal: AbortSignal.timeout(1500) })
    if (!r.ok) return []
    const rows = await r.json()
    if (!Array.isArray(rows)) return []
    return turnsFromEvents(rows as EventRow[])
  } catch {
    return []
  }
}

function turnsFromEvents(rows: EventRow[]): InspectTurn[] {
  const normalized = rows.map((r) => ({ ...r, ts: isoTs(r.ts) }))
  const byTurn = new Map<string, EventRow[]>()
  for (const row of normalized) {
    if (!row.turn) continue
    byTurn.set(row.turn, [...(byTurn.get(row.turn) ?? []), row])
  }
  const ttsRows = normalized.filter((r) => r.type === 'tts_done')
  const turns: InspectTurn[] = []
  for (const [id, events] of byTurn) {
    const done = events.find((e) => e.type === 'chat_done')
    if (!done?.text) continue
    const user = events.find((e) => e.type === 'user_utterance')
    const firstToken = events.find((e) => e.type === 'chat_first_token')
    const tts = events.find((e) => e.type === 'tts_done') ?? ttsNear(ttsRows, done.ts)
    const durationMs = Math.round(done.text.length * 58 + 380)
    turns.push({
      id,
      ts: user?.ts ?? done.ts,
      user: user?.text ?? '',
      text: done.text,
      durationMs,
      latencyMs: Number((done.meta as { firstTokenMs?: number } | undefined)?.firstTokenMs ?? firstToken?.ms ?? done.ms ?? 0),
      provider: tts?.provider ?? 'no tts',
      words: layoutWords(done.text, durationMs),
      source: 'rawtree',
    })
  }
  return turns.sort((a, b) => a.ts.localeCompare(b.ts))
}

function isoTs(ts: string) {
  const trimmed = ts.trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1')
  return /[zZ]|[+-]\d\d:?\d\d$/.test(trimmed) ? trimmed : `${trimmed}Z`
}

function ttsNear(rows: EventRow[], doneTs: string) {
  const t0 = Date.parse(doneTs)
  return rows.find((r) => r.turn == null && Date.parse(r.ts) >= t0 && Date.parse(r.ts) - t0 < 90_000)
}

function attachWav(slug: string, turn: InspectTurn): InspectTurn {
  const cached = cachedKeys(slug, turn.text)
  if (cached) return { ...turn, wav: `/api/inspect/${slug}/wav/cache/${cached.join('+')}`, provider: cacheProvider(cached[0]) ?? turn.provider }
  const dir = join(REVIEW_DIR, 'voice')
  if (!existsSync(dir)) return turn
  const wanted = normalize(turn.text)
  const sha = createHash('sha1').update(`prannay-v1${turn.text}`).digest('hex')
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.wav')) continue
    const base = file.slice(0, -4)
    const sidecar = join(dir, `${base}.txt`)
    const matchesSidecar = existsSync(sidecar) && normalize(readFileSync(sidecar, 'utf8')) === wanted
    if (matchesSidecar || base === sha || base === `${slug}-${turn.id}`) {
      return { ...turn, wav: `/api/inspect/${slug}/wav/${file}` }
    }
  }
  return turn
}

function cachedKeys(slug: string, text: string) {
  let run: string
  try { run = loadManifest(slug).voice.run } catch { return null }
  const splitter = sentenceSplitter()
  const sentences = [...splitter.push(text), ...splitter.flush()].slice(0, MAX_SENTENCES)
  if (!sentences.length) return null
  const keys = sentences.map((s) => createHash('sha1').update(`${run}\n${s}`).digest('hex'))
  const hit = keys.every((k) => existsSync(join(TTS_CACHE_DIR, `${k}.wav`)) && !cacheProvider(k)?.startsWith('local:'))
  return hit ? keys : null
}

function cacheProvider(key: string): string | undefined {
  try { return String(JSON.parse(readFileSync(join(TTS_CACHE_DIR, `${key}.json`), 'utf8')).provider) } catch { return undefined }
}

function concatWav(files: Buffer[]) {
  const pcm = files.map(dataChunk)
  const total = pcm.reduce((n, b) => n + b.length, 0)
  const head = Buffer.from(files[0].subarray(0, 44))
  head.writeUInt32LE(36 + total, 4)
  head.write('data', 36)
  head.writeUInt32LE(total, 40)
  return Buffer.concat([head, ...pcm])
}

function dataChunk(wav: Buffer) {
  let off = 12
  while (off + 8 <= wav.length) {
    const id = wav.toString('ascii', off, off + 4)
    const size = wav.readUInt32LE(off + 4)
    if (id === 'data') return wav.subarray(off + 8, Math.min(wav.length, off + 8 + size))
    off += 8 + size + (size % 2)
  }
  return wav.subarray(44)
}

function normalize(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

const VOICE_TAGS = ['pronunciation', 'pacing', 'timbre', 'artifact']
const FACE_TAGS = ['lip-sync', 'glitch', 'lighting', 'gaze']

function validateFlag(f: Partial<InspectFlag>) {
  if (!f.turnId) return 'turnId required'
  if (f.track !== 'voice' && f.track !== 'face') return "track must be 'voice' or 'face'"
  const tags = f.track === 'voice' ? VOICE_TAGS : FACE_TAGS
  if (!tags.includes(String(f.tag))) return `tag must be one of ${tags.join(', ')}`
  const start = Number(f.start)
  const end = Number(f.end)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 'start/end must be seconds with end > start'
  return null
}

const JOB_STAGES: { status: DistillJobStatus; until: number; detail: string }[] = [
  { status: 'queued', until: 8_000, detail: 'waiting for an A100' },
  { status: 'preparing', until: 30_000, detail: 'slicing flagged regions, re-tokenizing' },
  { status: 'training', until: 210_000, detail: 'LoRA r=16 on flagged spans, 120 steps' },
  { status: 'evaluating', until: 270_000, detail: 'speaker similarity + WER on held-out' },
]
const JOB_TOTAL_MS = 270_000

function advance(job: DistillJob): DistillJob {
  const elapsed = Date.now() - Date.parse(job.createdAt)
  const stage = JOB_STAGES.find((s) => elapsed < s.until)
  if (!stage) {
    return { ...job, status: 'done', progress: 1, detail: `merged into ${job.engram}-v1.1 from step ${job.fromCheckpoint}` }
  }
  return {
    ...job,
    status: stage.status,
    progress: Math.min(0.99, elapsed / JOB_TOTAL_MS),
    detail: stage.detail,
    eta: new Date(Date.parse(job.createdAt) + JOB_TOTAL_MS).toISOString(),
  }
}

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file) || statSync(file).size === 0) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try { return [JSON.parse(l) as T] } catch { return [] }
    })
}

async function logEvent(row: Omit<EventRow, 'ts'>) {
  try {
    await fetch(`${SELF}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(row),
      signal: AbortSignal.timeout(1500),
    })
  } catch {}
}
