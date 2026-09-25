import Nimble from '@nimble-way/nimble-js'

export type WebHit = { title: string; url: string; snippet: string }
export type WebResult = { query: string; answer?: string; hits: WebHit[] }
export type NimbleStatus = { ok: boolean; at?: string; detail: string }

const SNIPPET_CHARS = 300
const TITLE_CHARS = 60
let client: Nimble | undefined
export let lastStatus: NimbleStatus = { ok: !!process.env.NIMBLE_API_KEY, detail: process.env.NIMBLE_API_KEY ? 'key present, no call yet' : 'NIMBLE_API_KEY missing' }

function getClient() {
  if (!process.env.NIMBLE_API_KEY) throw new Error('NIMBLE_API_KEY missing')
  client ??= new Nimble({ apiKey: process.env.NIMBLE_API_KEY })
  return client
}

export async function searchWeb(query: string, maxResults = 3, withAnswer = false, timeoutMs = 8000): Promise<WebResult> {
  const started = Date.now()
  try {
    const r = await getClient().search(
      { query, max_results: maxResults, include_answer: withAnswer },
      { signal: AbortSignal.timeout(timeoutMs) },
    )
    const hits = (r.results ?? []).slice(0, maxResults).map((hit) => ({
      title: clampTitle(clean(hit.title)) || hostname(hit.url),
      url: hit.url,
      snippet: focusSnippet(clean(hit.description || hit.content), query),
    }))
    lastStatus = { ok: true, at: new Date().toISOString(), detail: `${hits.length} results in ${Date.now() - started} ms` }
    return { query, answer: r.answer ? clean(r.answer) : undefined, hits }
  } catch (e) {
    lastStatus = { ok: false, at: new Date().toISOString(), detail: (e as Error).message }
    throw e
  }
}

export const clean = (s: string | null | undefined) =>
  (s ?? '')
    .replace(/\[\d+\]/g, '')
    .replace(/[#*_>|]+/g, ' ')
    .replace(/(^|\s)-{2,}(?=\s|$)/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()

export function clampTitle(title: string, max = TITLE_CHARS) {
  const short = title.split(/\s+[·|]\s+/)[0].trim()
  if (short.length <= max) return short
  const head = short.slice(0, max)
  const cut = head.lastIndexOf(' ')
  return `${(cut > max / 2 ? head.slice(0, cut) : head).replace(/[\s,;:—–-]+$/, '')}…`
}

export const hostname = (url: string) => {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

function focusSnippet(text: string, query: string) {
  const keywords = new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3))
  const minScore = Math.min(2, keywords.size)
  const sentences = text.split(/(?<=[.!?])\s+/).filter(isProse)
  const scored = sentences
    .map((s, i) => ({ s, i, score: new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => keywords.has(w))).size }))
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score || a.i - b.i)
  let out = ''
  for (const { s } of scored) {
    if (out.length + s.length > SNIPPET_CHARS) break
    out += (out ? ' ' : '') + s
  }
  return out
}

function isProse(sentence: string) {
  const words = sentence.split(/\s+/)
  if (words.length < 8 || !/[a-z][.!?]$/.test(sentence) || /[{}[\]<>=]|https?:\/\//.test(sentence)) return false
  const capitalized = words.filter((w) => /^[A-Z]/.test(w)).length
  const numeric = words.filter((w) => /\d/.test(w)).length
  return capitalized / words.length < 0.5 && numeric / words.length < 0.2
}
