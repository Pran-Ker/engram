import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { OLLAMA_URL } from './liquid.ts'

const MODELS = [process.env.EMBED_MODEL ?? 'all-minilm', 'nomic-embed-text']
const CACHE_FILE = resolve(process.env.EMBED_CACHE ?? 'review/qa-embeddings.json')
const BATCH = 64
const SAVE_DEBOUNCE_MS = 500

type CacheFile = { model: string; vectors: Record<string, number[]> }

let model = MODELS[0]
const vectors = new Map<string, number[]>()
let dirty = false
let saveTimer: NodeJS.Timeout | undefined

loadCache()

export const sha1 = (text: string) => createHash('sha1').update(text).digest('hex')

export const embedModel = () => model

export async function embedAll(texts: string[]): Promise<number[][]> {
  const missing = [...new Set(texts.filter((t) => !vectors.has(sha1(t))))]
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH)
    const got = await requestEmbeddings(batch)
    batch.forEach((text, j) => vectors.set(sha1(text), got[j]))
    dirty = true
  }
  if (dirty) scheduleSave()
  return texts.map((t) => vectors.get(sha1(t))!)
}

export const embedOne = async (text: string) => (await embedAll([text]))[0]

export function cosine(a: number[], b: number[]) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

async function requestEmbeddings(input: string[]): Promise<number[][]> {
  for (const candidate of MODELS.slice(MODELS.indexOf(model))) {
    const r = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: 'POST',
      body: JSON.stringify({ model: candidate, input, keep_alive: '2h' }),
      signal: AbortSignal.timeout(30000),
    })
    if (r.ok) {
      if (candidate !== model) switchModel(candidate)
      const j = (await r.json()) as { embeddings: number[][] }
      return j.embeddings
    }
    console.warn(`[embed] ${candidate} unavailable (${r.status}), trying next`)
  }
  throw new Error('no embedding model available in ollama')
}

function switchModel(next: string) {
  console.warn(`[embed] switched to ${next}, dropping cache`)
  model = next
  vectors.clear()
}

function loadCache() {
  if (!existsSync(CACHE_FILE)) return
  try {
    const file = JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as CacheFile
    if (file.model !== model) return
    for (const [key, vec] of Object.entries(file.vectors)) vectors.set(key, vec)
    console.log(`[embed] ${vectors.size} cached vectors (${model})`)
  } catch {}
}

function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    dirty = false
    const file: CacheFile = { model, vectors: Object.fromEntries(vectors) }
    try {
      mkdirSync(dirname(CACHE_FILE), { recursive: true })
      writeFileSync(CACHE_FILE, JSON.stringify(file))
    } catch (e) { console.warn(`[embed] cache write failed: ${(e as Error).message}`) }
  }, SAVE_DEBOUNCE_MS)
}
