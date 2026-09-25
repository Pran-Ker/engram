import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Health } from '../../shared/types.ts'

const URL_FILE = fileURLToPath(new URL('../../../voice/.tts-url', import.meta.url))
const TTS_TIMEOUT_MS = 45_000
const HEALTH_TIMEOUT_MS = 5_000

export type ModalTts = {
  wav: Buffer
  provider: string
  ms: number
}

export function ttsUrl(): string | null {
  const env = process.env.ENGRAM_TTS_URL?.trim()
  if (env) return env.replace(/\/$/, '')
  if (!existsSync(URL_FILE)) return null
  const fromFile = readFileSync(URL_FILE, 'utf8').trim()
  return fromFile ? fromFile.replace(/\/$/, '') : null
}

export async function modalTts(text: string, run: string, systemPrompt: string): Promise<ModalTts> {
  const base = ttsUrl()
  if (!base) throw new Error('no TTS url: set ENGRAM_TTS_URL or run `make deploy` in ../voice')
  const t0 = Date.now()
  const r = await fetch(`${base}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, run, system_prompt: systemPrompt }),
    signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
  })
  if (!r.ok) throw new Error(`modal tts ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return {
    wav: Buffer.from(await r.arrayBuffer()),
    provider: r.headers.get('x-voice-provider') ?? 'modal:unknown',
    ms: Date.now() - t0,
  }
}

export type ModalStream = {
  body: ReadableStream<Uint8Array>
  provider: string
}

export async function modalTtsStream(text: string, run: string, systemPrompt: string): Promise<ModalStream> {
  const base = ttsUrl()
  if (!base) throw new Error('no TTS url: set ENGRAM_TTS_URL or run `make deploy` in ../voice')
  const r = await fetch(`${base}/tts/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, run, system_prompt: systemPrompt }),
    signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
  })
  if (!r.ok || !r.body) throw new Error(`modal tts/stream ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return { body: r.body, provider: r.headers.get('x-voice-provider') ?? 'modal:unknown' }
}

export async function modalHealth(run: string): Promise<Record<string, unknown>> {
  const base = ttsUrl()
  if (!base) throw new Error('no TTS url')
  const r = await fetch(`${base}/health?run=${encodeURIComponent(run)}`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
  if (!r.ok) throw new Error(`modal health ${r.status}`)
  return { url: base, ...(await r.json()) }
}

export async function ttsHealth(run = 'prannay-v1'): Promise<Health['tts']> {
  try {
    const h = await modalHealth(run)
    return { ok: true, provider: String(h.provider), detail: h.run_exists ? `fine-tuned run ${run}` : `base voice, run ${run} not trained yet` }
  } catch (e) {
    return { ok: false, detail: (e as Error).message }
  }
}
