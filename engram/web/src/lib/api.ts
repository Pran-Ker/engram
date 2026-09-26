// Thin typed client for the server API. Shared by pages; keep it small.
import type { EngramManifest, EngramSummary, ContextCard, ChatEvent, ChatMessage, EventRow } from '../../../shared/types.ts'

export const api = {
  engrams: () => get<EngramSummary[]>('/api/engrams'),
  config: () => get<{ dashboard: string }>('/api/config'),
  engram: (slug: string) => get<EngramManifest & { cards: number }>(`/api/engrams/${slug}`),
  cards: (slug: string) => get<ContextCard[]>(`/api/engrams/${slug}/context`),
  addWebContext: (slug: string, query: string) =>
    post<ContextCard[]>(`/api/engrams/${slug}/context/web`, { query }),
  videoUrl: (slug: string, clip: 'idle' | 'talk' | 'poster' | 'intro') => `/api/engrams/${slug}/video/${clip}`,
  tts: async (slug: string, text: string, turnId?: string, signal?: AbortSignal): Promise<{ audio: ArrayBuffer; provider: string }> => {
    const r = await fetch(`/api/engrams/${slug}/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, turnId }), signal })
    if (!r.ok) throw new Error(`tts ${r.status}: ${await r.text()}`)
    return { audio: await r.arrayBuffer(), provider: r.headers.get('x-voice-provider') ?? 'unknown' }
  },
  /** Streams raw s16le 24 kHz mono PCM. Rejects on 503 (stream unavailable) or network failure; resolves when the stream ends. */
  ttsStream: async (
    slug: string,
    text: string,
    turnId: string | undefined,
    onChunk: (pcm: Int16Array) => void,
    signal?: AbortSignal,
  ): Promise<{ provider: string }> => {
    const r = await fetch(`/api/engrams/${slug}/tts/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, turnId }), signal })
    if (!r.ok || !r.body) throw new Error(`tts stream ${r.status}: ${await r.text()}`)
    const provider = r.headers.get('x-voice-provider') ?? 'unknown'
    const reader = r.body.getReader()
    let carry: Uint8Array | null = null
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      const bytes: Uint8Array = carry ? joinBytes(carry, value) : value
      const even = bytes.length & ~1
      carry = even < bytes.length ? bytes.slice(even) : null
      if (even) onChunk(samplesOf(bytes, even))
    }
    return { provider }
  },
  event: (row: Omit<EventRow, 'ts'>) =>
    fetch('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(row) }).catch(() => {}),
  /** Streams chat events. Resolves when the stream ends. */
  chat: async (slug: string, body: { messages: ChatMessage[]; sessionId: string }, onEvent: (e: ChatEvent) => void, signal?: AbortSignal) => {
    const r = await fetch(`/api/engrams/${slug}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
    if (!r.ok || !r.body) throw new Error(`chat ${r.status}: ${await r.text()}`)
    const reader = r.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2)
        const line = chunk.split('\n').find((l) => l.startsWith('data:'))
        if (line) onEvent(JSON.parse(line.slice(5).trim()))
      }
    }
  },
}

const joinBytes = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

const samplesOf = (bytes: Uint8Array, length: number) =>
  bytes.byteOffset % 2
    ? new Int16Array(bytes.slice(0, length).buffer)
    : new Int16Array(bytes.buffer, bytes.byteOffset, length / 2)

export class ApiError extends Error {
  status: number
  detail: string
  constructor(url: string, status: number, text: string) {
    super(`${url} ${status}: ${text}`)
    this.status = status
    this.detail = sentenceOf(text)
  }
}

const sentenceOf = (text: string) => {
  try { return String((JSON.parse(text) as { error?: string }).error ?? text) } catch { return text }
}

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url)
  if (!r.ok) throw new ApiError(url, r.status, await r.text())
  return r.json()
}
async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new ApiError(url, r.status, await r.text())
  return r.json()
}
