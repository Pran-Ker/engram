import { Hono } from 'hono'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { EventRow } from '../../shared/types.ts'
import { loadManifest } from '../lib/engram-store.ts'
import { modalHealth, modalTts, modalTtsStream, ttsUrl } from '../lib/tts-modal.ts'
import { LOCAL_PROVIDER, localAvailable, localSay } from '../lib/tts-local.ts'
import { GEMINI_PROVIDER, geminiAvailable, geminiTts, geminiTtsStream } from '../lib/tts-gemini.ts'

export const tts = new Hono()

const CACHE_DIR = resolve(process.env.TTS_CACHE_DIR ?? 'review/tts-cache')
const EVENTS_URL = process.env.ENGRAM_EVENTS_URL ?? `http://localhost:${process.env.PORT ?? 4100}/api/events`
const ALLOW_LOCAL = process.env.ENGRAM_TTS_LOCAL !== '0'
// auto: the fine-tuned run on Modal when it exists, otherwise Gemini (fast, hosted), otherwise Modal base, otherwise local say.
// gemini | modal | local force one family first. Fallbacks after it stay the same.
const PROVIDER = (process.env.ENGRAM_TTS_PROVIDER ?? 'auto') as 'auto' | 'gemini' | 'modal' | 'local'
const FINE_TUNE_TTL_MS = 60_000
const SPLIT_CHARS = 70
const SPLIT_WINDOW = 0.3
const GAP_MS = 140
const RATE = 24_000
const CLAUSE = /,\s|;\s|:\s|\s[—–-]\s|\sbut\s|\sand\s|\sso\s|\sbecause\s/g

type Synth = {
  wav: Buffer
  provider: string
  ms: number
  parts: number
}

tts.post('/:slug/tts', async (c) => {
  const slug = c.req.param('slug')
  const body = await c.req.json().catch(() => ({}))
  const text = String(body.text ?? '').trim()
  const turn = body.turnId ? String(body.turnId) : undefined
  if (!text) return c.json({ error: 'text is required' }, 400)
  const manifest = manifestOr404(slug)
  if (!manifest) return c.json({ error: `no engram ${slug}` }, 404)
  const { run, systemPrompt } = manifest.voice
  const gemini = await geminiFirst(run)
  const key = cacheKey(gemini, run, text)

  const cached = readCache(key)
  if (cached) return wavResponse(cached.wav, cached.provider, { 'x-voice-cache': 'hit' })

  const t0 = Date.now()
  const onFallback = (provider: string, reason: string) =>
    logEvent({ engram: slug, session: 'server', turn, type: 'tts_fallback', provider, chars: text.length, text: reason })
  let result: Synth | null = null
  if (gemini) {
    try {
      result = await geminiTts(text)
    } catch (e) {
      console.warn(`[tts] gemini failed: ${(e as Error).message}`)
      onFallback('modal', `gemini failed: ${(e as Error).message}`)
    }
  }
  if (!result) result = await synthesize(text, run, systemPrompt, onFallback)
  if (!result) return c.json({ error: 'no TTS provider available: Gemini/Modal unreachable and local say disabled' }, 503)

  writeCache(key, result)
  logEvent({ engram: slug, session: 'server', turn, type: 'tts_done', ms: Date.now() - t0, provider: result.provider, chars: text.length, meta: { modalMs: result.ms, parts: result.parts } })
  return wavResponse(result.wav, result.provider, { 'x-voice-cache': 'miss', 'x-voice-ms': String(result.ms), 'x-voice-parts': String(result.parts) })
})

tts.post('/:slug/tts/stream', async (c) => {
  const slug = c.req.param('slug')
  const body = await c.req.json().catch(() => ({}))
  const text = String(body.text ?? '').trim()
  const turn = body.turnId ? String(body.turnId) : undefined
  if (!text) return c.json({ error: 'text is required' }, 400)
  const manifest = manifestOr404(slug)
  if (!manifest) return c.json({ error: `no engram ${slug}` }, 404)
  const { run, systemPrompt } = manifest.voice
  const gemini = await geminiFirst(run)
  const key = cacheKey(gemini, run, text)

  const cached = readCache(key)
  if (cached) return pcmResponse(new Blob([new Uint8Array(pcmOf(cached.wav))]).stream(), cached.provider, { 'x-voice-cache': 'hit' })

  const t0 = Date.now()
  if (gemini) {
    // Clauses are generated in parallel and emitted in order; each chunk is a whole clause, so no hold is needed.
    const upstream = geminiTtsStream(text)
    const tee = teeToCache(key, upstream.provider, 0, (ms, firstMs) =>
      logEvent({ engram: slug, session: 'server', turn, type: 'tts_done', ms, provider: upstream.provider, chars: text.length, meta: { firstMs, stream: true, parts: upstream.parts } }),
      t0)
    return pcmResponse(upstream.body.pipeThrough(tee), upstream.provider, { 'x-voice-cache': 'miss', 'x-voice-parts': String(upstream.parts) })
  }

  let upstream
  try {
    upstream = await modalTtsStream(text, run, systemPrompt)
  } catch (e) {
    return c.json({ error: `stream unavailable: ${(e as Error).message}` }, 503)
  }
  if (run !== 'base' && upstream.provider === 'modal:base')
    logEvent({ engram: slug, session: 'server', turn, type: 'tts_fallback', provider: upstream.provider, chars: text.length, text: `run ${run} not on Modal yet` })

  // Modal generates at ~0.87x real time, so long sentences need a head start or the browser re-buffers mid-sentence.
  // Hold the first ~15% of the estimated duration (minus what the client already holds), at least 0.4 s so short sentences do not re-buffer, capped, then pass through.
  const estSeconds = text.length * 0.08
  const holdBytes = Math.round(Math.min(1.6, Math.max(0.4, 0.15 * estSeconds - 0.6)) * 48_000)
  const tee = teeToCache(key, upstream.provider, holdBytes, (ms, firstMs) =>
    logEvent({ engram: slug, session: 'server', turn, type: 'tts_done', ms, provider: upstream.provider, chars: text.length, meta: { firstMs, stream: true } }),
    t0)
  return pcmResponse(upstream.body.pipeThrough(tee), upstream.provider, { 'x-voice-cache': 'miss' })
})

tts.get('/:slug/tts/health', async (c) => {
  const slug = c.req.param('slug')
  const manifest = manifestOr404(slug)
  if (!manifest) return c.json({ error: `no engram ${slug}` }, 404)
  const { run } = manifest.voice
  const gemini = await geminiFirst(run)
  const common = { run, first: gemini ? GEMINI_PROVIDER : 'modal', mode: PROVIDER, gemini: geminiAvailable(), local: localAvailable() && ALLOW_LOCAL }
  try {
    const modal = await modalHealth(run)
    return c.json({ ok: true, ...common, ...modal, provider: gemini ? GEMINI_PROVIDER : String(modal.provider ?? 'modal') })
  } catch (e) {
    return c.json({ ok: gemini, ...common, provider: gemini ? GEMINI_PROVIDER : undefined, url: ttsUrl(), detail: `modal: ${(e as Error).message}` }, gemini ? 200 : 503)
  }
})

// --- provider choice -------------------------------------------------------------------------------------------

let fineTune: { run: string; ready: boolean; at: number } | null = null

/** True when Modal reports the fine-tuned checkpoint for this run. Cached for a minute; false when Modal is unreachable. */
async function fineTuneReady(run: string): Promise<boolean> {
  if (run === 'base') return false
  if (fineTune && fineTune.run === run && Date.now() - fineTune.at < FINE_TUNE_TTL_MS) return fineTune.ready
  let ready = false
  try {
    const h = await modalHealth(run)
    ready = !!h.run_exists
  } catch {}
  fineTune = { run, ready, at: Date.now() }
  return ready
}

async function geminiFirst(run: string): Promise<boolean> {
  if (!geminiAvailable()) return false
  if (PROVIDER === 'gemini') return true
  if (PROVIDER === 'modal' || PROVIDER === 'local') return false
  return !(await fineTuneReady(run))
}

function cacheKey(gemini: boolean, run: string, text: string) {
  return gemini ? sha1(`${GEMINI_PROVIDER}\n${text}`) : sha1(`${run}\n${text}`)
}

/** Passes PCM through, optionally holding the first `holdBytes`, and writes the whole take to the disk cache on flush. */
function teeToCache(key: string, provider: string, holdBytes: number, onDone: (ms: number, firstMs: number) => void, t0: number) {
  const parts: Buffer[] = []
  let firstMs = 0
  let held: Buffer[] = []
  let heldBytes = 0
  let released = holdBytes === 0
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (!firstMs) firstMs = Date.now() - t0
      parts.push(Buffer.from(chunk))
      if (released) return controller.enqueue(chunk)
      held.push(Buffer.from(chunk))
      heldBytes += chunk.byteLength
      if (heldBytes >= holdBytes) {
        controller.enqueue(new Uint8Array(Buffer.concat(held)))
        held = []
        released = true
      }
    },
    flush(controller) {
      if (held.length) controller.enqueue(new Uint8Array(Buffer.concat(held)))
      const ms = Date.now() - t0
      if (parts.length) writeCache(key, { wav: wavOf(Buffer.concat(parts)), provider, ms, parts: 1 })
      onDone(ms, firstMs)
    },
  })
}

async function synthesize(
  text: string,
  run: string,
  systemPrompt: string,
  onFallback: (provider: string, reason: string) => void,
): Promise<Synth | null> {
  try {
    const parts = splitClauses(text)
    const results = await Promise.all(parts.map((part) => modalTts(part, run, systemPrompt)))
    const provider = results[0].provider
    if (run !== 'base' && provider === 'modal:base') onFallback(provider, `run ${run} not on Modal yet`)
    return {
      wav: results.length === 1 ? results[0].wav : joinWavs(results.map((r) => r.wav)),
      provider,
      ms: Math.max(...results.map((r) => r.ms)),
      parts: results.length,
    }
  } catch (e) {
    const reason = (e as Error).message
    console.warn(`[tts] modal failed: ${reason}`)
    if (!localAvailable() || !ALLOW_LOCAL) return null
    onFallback(LOCAL_PROVIDER, reason)
    const t0 = Date.now()
    const wav = await localSay(text)
    return { wav, provider: LOCAL_PROVIDER, ms: Date.now() - t0, parts: 1 }
  }
}

export function splitClauses(text: string): string[] {
  if (text.length <= SPLIT_CHARS) return [text]
  const mid = text.length / 2
  const lo = text.length * SPLIT_WINDOW
  const hi = text.length * (1 - SPLIT_WINDOW)
  let best: number | null = null
  for (const m of text.matchAll(CLAUSE)) {
    const at = m.index + (m[0].startsWith(',') || m[0].startsWith(';') || m[0].startsWith(':') ? 1 : 0)
    if (at < lo || at > hi) continue
    if (best === null || Math.abs(at - mid) < Math.abs(best - mid)) best = at
  }
  if (best === null) return [text]
  const head = text.slice(0, best).trim()
  const tail = text.slice(best).trim()
  return head && tail ? [head, tail] : [text]
}

function joinWavs(wavs: Buffer[]): Buffer {
  const gap = Buffer.alloc((RATE * GAP_MS / 1000) * 2)
  const pcm: Buffer[] = []
  wavs.forEach((wav, i) => {
    if (i) pcm.push(gap)
    pcm.push(pcmOf(wav))
  })
  return wavOf(Buffer.concat(pcm))
}

function pcmOf(wav: Buffer): Buffer {
  let at = 12
  while (at + 8 <= wav.length) {
    const id = wav.toString('ascii', at, at + 4)
    const size = wav.readUInt32LE(at + 4)
    if (id === 'data') return wav.subarray(at + 8, Math.min(wav.length, at + 8 + size))
    at += 8 + size + (size % 2)
  }
  return wav.subarray(44)
}

function wavOf(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(RATE, 24)
  header.writeUInt32LE(RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

function manifestOr404(slug: string) {
  try {
    return loadManifest(slug)
  } catch {
    return null
  }
}

function wavResponse(wav: Buffer, provider: string, extra: Record<string, string>) {
  return new Response(new Uint8Array(wav), {
    headers: {
      'Content-Type': 'audio/wav',
      'Content-Length': String(wav.length),
      'Cache-Control': 'no-store',
      'x-voice-provider': provider,
      ...extra,
    },
  })
}

function pcmResponse(body: ReadableStream<Uint8Array>, provider: string, extra: Record<string, string>) {
  return new Response(body, {
    headers: {
      'Content-Type': 'audio/pcm',
      'Cache-Control': 'no-store',
      'x-voice-provider': provider,
      'x-voice-rate': String(RATE),
      'x-voice-format': 's16le mono',
      ...extra,
    },
  })
}

function sha1(s: string) {
  return createHash('sha1').update(s).digest('hex')
}

function readCache(key: string): Synth | null {
  const wavPath = join(CACHE_DIR, `${key}.wav`)
  const metaPath = join(CACHE_DIR, `${key}.json`)
  if (!existsSync(wavPath) || !existsSync(metaPath)) return null
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  if (meta.provider === LOCAL_PROVIDER) return null
  return { wav: readFileSync(wavPath), provider: meta.provider, ms: 0, parts: meta.parts ?? 1 }
}

function writeCache(key: string, r: Synth) {
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(join(CACHE_DIR, `${key}.wav`), r.wav)
  writeFileSync(join(CACHE_DIR, `${key}.json`), JSON.stringify({ provider: r.provider, ms: r.ms, parts: r.parts, at: new Date().toISOString() }))
}

function logEvent(row: Omit<EventRow, 'ts'>) {
  console.log(`[tts] ${row.type} ${row.provider ?? ''} ${row.ms ?? ''}ms ${row.text ?? ''}`.trim())
  fetch(EVENTS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(row),
    signal: AbortSignal.timeout(3_000),
  }).catch(() => {})
}
