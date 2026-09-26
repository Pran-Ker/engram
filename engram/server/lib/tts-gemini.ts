// Gemini 2.5 Flash TTS as a hosted voice for the stage while the Liquid fine-tune is not trained yet.
// Latency grows with clause length (measured 2026-09-25: 4 words 1.4 s, 12 words 2.8 s, 23 words 3.8 s), and the API
// returns one audio chunk per request, so the stream path splits the reply into short clauses, generates them in
// parallel, and emits them in order: first audio in ~1.5 s, the rest lands while the first clause plays.

const MODEL = process.env.GEMINI_TTS_MODEL ?? 'gemini-2.5-flash-preview-tts'
const VOICE = process.env.GEMINI_TTS_VOICE ?? 'Puck'
const STYLE = process.env.GEMINI_TTS_STYLE ?? 'Say this casually and warmly at a natural pace, like a founder talking to a visitor at a demo:'
const RATE = 24_000
const TIMEOUT_MS = 20_000
const MAX_PARALLEL = 4
const GAP_MS = 120
const TARGET_WORDS = 12
const MAX_WORDS = 18
const FIRST_MAX_WORDS = 10   // latency floor is ~2.3 s up to ~10 words, ~3.7 s at 17: keep the opening clause short so audio starts early

export const GEMINI_PROVIDER = `gemini:${VOICE}`

export type GeminiTts = { wav: Buffer; provider: string; ms: number; parts: number }
export type GeminiStream = { body: ReadableStream<Uint8Array>; provider: string; parts: number }

function apiKey(): string | undefined {
  return process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || undefined
}

export function geminiAvailable(): boolean {
  return !!apiKey()
}

/** One request -> raw PCM s16le mono 24 kHz. */
export async function geminiPcm(text: string): Promise<Buffer> {
  const key = apiKey()
  if (!key) throw new Error('GEMINI_API_KEY missing')
  const body = {
    contents: [{ parts: [{ text: `${STYLE} ${text}` }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
    },
  }
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!r.ok) throw new Error(`gemini tts ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const j = (await r.json()) as {
    candidates?: { content?: { parts?: { inlineData?: { mimeType: string; data: string } }[] }; finishReason?: string }[]
  }
  const parts = j.candidates?.[0]?.content?.parts ?? []
  const chunks = parts.filter((p) => p.inlineData?.data).map((p) => p.inlineData!)
  if (!chunks.length) throw new Error(`gemini tts returned no audio (${j.candidates?.[0]?.finishReason ?? 'no candidate'})`)
  const rate = Number(/rate=(\d+)/.exec(chunks[0].mimeType)?.[1] ?? RATE)
  const pcm = Buffer.concat(chunks.map((c) => Buffer.from(c.data, 'base64')))
  return rate === RATE ? pcm : resample(pcm, rate, RATE)
}

/** Whole reply as one wav. Clauses are generated in parallel so latency is that of the longest clause. */
export async function geminiTts(text: string): Promise<GeminiTts> {
  const t0 = Date.now()
  const parts = splitForStreaming(text)
  const pcms = await mapLimit(parts, MAX_PARALLEL, geminiPcm)
  const gap = Buffer.alloc((RATE * GAP_MS) / 1000 * 2)
  const pcm = Buffer.concat(pcms.flatMap((p, i) => (i ? [gap, p] : [p])))
  return { wav: wavOf(pcm), provider: GEMINI_PROVIDER, ms: Date.now() - t0, parts: parts.length }
}

/** Raw PCM stream: clauses fire in parallel, are emitted in order, with a short gap between them. */
export function geminiTtsStream(text: string): GeminiStream {
  const parts = splitForStreaming(text)
  const gap = new Uint8Array((RATE * GAP_MS) / 1000 * 2)
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const pending = parts.map((p, i) => (i < MAX_PARALLEL ? geminiPcm(p) : null))
        for (let i = 0; i < parts.length; i++) {
          const next = i + MAX_PARALLEL
          if (next < parts.length) pending[next] = geminiPcm(parts[next])
          const pcm = await pending[i]!
          if (i) controller.enqueue(gap)
          controller.enqueue(new Uint8Array(pcm))
        }
        controller.close()
      } catch (e) {
        controller.error(e)
      }
    },
  })
  return { body, provider: GEMINI_PROVIDER, parts: parts.length }
}

/** Sentences first; a sentence over MAX_WORDS is cut at the comma/conjunction nearest its middle, recursively. */
export function splitForStreaming(text: string): string[] {
  const sentences = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?…]["”')]?)\s+(?=\S)/)
    .filter(Boolean)
  const out: string[] = []
  for (const s of sentences) out.push(...splitLong(s))
  // merge very short tails ("Yeah." / "Right?") into the previous clause so they do not cost a round trip each
  const merged: string[] = []
  for (const p of out) {
    const prev = merged[merged.length - 1]
    if (prev && words(p) <= 2 && words(prev) + words(p) <= MAX_WORDS) merged[merged.length - 1] = `${prev} ${p}`
    else merged.push(p)
  }
  if (merged.length && words(merged[0]) > FIRST_MAX_WORDS) {
    const [head, tail] = splitFirst(merged[0])
    if (tail) merged.splice(0, 1, head, tail)
  }
  return merged.length ? merged : [text]
}

/** Cut the opening clause at the earliest natural boundary that leaves 3..FIRST_MAX_WORDS words in front. */
function splitFirst(s: string): [string, string?] {
  let best: number | null = null
  for (const m of s.matchAll(/,\s|;\s|:\s|\s[—–-]\s|\sbut\s|\sand\s|\sso\s|\sbecause\s|\swhich\s|\sthat\s|\swhere\s|\swhen\s/g)) {
    const at = m.index + (/^[,;:]/.test(m[0]) ? 1 : 0)
    const n = words(s.slice(0, at))
    if (n < 3 || n > FIRST_MAX_WORDS) continue
    best = at
    break
  }
  if (best === null) return [s]
  const head = s.slice(0, best).trim()
  const tail = s.slice(best).trim()
  return words(tail) >= 2 ? [head, tail] : [s]
}

function splitLong(s: string): string[] {
  if (words(s) <= MAX_WORDS) return [s]
  const mid = s.length / 2
  let best: number | null = null
  for (const m of s.matchAll(/,\s|;\s|:\s|\s[—–-]\s|\sbut\s|\sand\s|\sso\s|\sbecause\s|\swhich\s|\sthat\s/g)) {
    const at = m.index + (/^[,;:]/.test(m[0]) ? 1 : 0)
    const head = s.slice(0, at).trim()
    const tail = s.slice(at).trim()
    if (words(head) < 3 || words(tail) < 3) continue
    if (best === null || Math.abs(at - mid) < Math.abs(best - mid)) best = at
  }
  if (best === null) return [s]
  const head = s.slice(0, best).trim()
  const tail = s.slice(best).trim()
  if (words(head) <= TARGET_WORDS && words(tail) <= TARGET_WORDS) return [head, tail]
  return [...splitLong(head), ...splitLong(tail)]
}

function words(s: string) {
  return s.split(/\s+/).filter(Boolean).length
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const at = i++
        out[at] = await fn(items[at])
      }
    }),
  )
  return out
}

function resample(pcm: Buffer, from: number, to: number): Buffer {
  const n = pcm.length / 2
  const m = Math.floor((n * to) / from)
  const out = Buffer.alloc(m * 2)
  for (let j = 0; j < m; j++) {
    const x = (j * from) / to
    const i0 = Math.floor(x)
    const i1 = Math.min(n - 1, i0 + 1)
    const a = pcm.readInt16LE(i0 * 2)
    const b = pcm.readInt16LE(i1 * 2)
    out.writeInt16LE(Math.round(a + (b - a) * (x - i0)), j * 2)
  }
  return out
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
