import { existsSync, watch } from 'node:fs'
import { join } from 'node:path'
import { engramDir } from './engram-store.ts'
import { sortedCards } from './cards.ts'
import { cosine, embedAll, embedOne } from './embed.ts'
import type { ContextCard } from '../../shared/types.ts'

export const QA_THRESHOLD = Number(process.env.QA_THRESHOLD ?? 0.65)
const CARD_PREVIEW = 300
const RELOAD_DEBOUNCE_MS = 500
const QA_LINE = /^Q:\s*(.+?)\s+A:\s*(.+)$/

export type Pair = { q: string; a: string; cardId: string }
export type Bank = {
  cards: ContextCard[]
  pairs: Pair[]
  pairVectors: number[][]
  cardVectors: Map<string, number[]>
}
export type Match = { pair: Pair; similarity: number }

const banks = new Map<string, Promise<Bank>>()
const watched = new Set<string>()

export function bank(slug: string): Promise<Bank> {
  watchContext(slug)
  let pending = banks.get(slug)
  if (!pending) {
    pending = build(slug)
    banks.set(slug, pending)
    pending.catch(() => banks.delete(slug))
  }
  return pending
}

export async function matchQuestion(slug: string, question: string): Promise<{ vector: number[]; best?: Match }> {
  const [b, vector] = await Promise.all([bank(slug), embedOne(question)])
  let best: Match | undefined
  b.pairs.forEach((pair, i) => {
    const similarity = cosine(vector, b.pairVectors[i])
    if (!best || similarity > best.similarity) best = { pair, similarity }
  })
  return { vector, best }
}

export function closestPairs(b: Bank, vector: number[], n: number): Pair[] {
  const ranked = b.pairs
    .map((pair, i) => ({ pair, similarity: cosine(vector, b.pairVectors[i]) }))
    .sort((x, y) => y.similarity - x.similarity)
  const seen = new Set<string>()
  const out: Pair[] = []
  for (const { pair } of ranked) {
    if (seen.has(pair.a)) continue
    seen.add(pair.a)
    out.push(pair)
    if (out.length === n) break
  }
  return out
}

export const cardSimilarity = (b: Bank, vector: number[], card: ContextCard) => {
  const cv = b.cardVectors.get(card.id)
  return cv ? cosine(vector, cv) : 0
}

export const parsePairs = (cards: ContextCard[]): Pair[] =>
  cards
    .filter((c) => c.section === 'voice')
    .flatMap((c) => c.body.split('\n').flatMap((line) => {
      const m = QA_LINE.exec(line.trim())
      return m ? [{ q: m[1], a: m[2], cardId: c.id }] : []
    }))

export const cardPreview = (card: ContextCard) => `${card.title}: ${card.body.replace(/\s+/g, ' ').slice(0, CARD_PREVIEW)}`

async function build(slug: string): Promise<Bank> {
  const started = Date.now()
  const cards = sortedCards(slug)
  const pairs = parsePairs(cards)
  const facts = cards.filter((c) => c.section !== 'voice')
  const vectors = await embedAll([...pairs.map((p) => p.q), ...facts.map(cardPreview)])
  const cardVectors = new Map(facts.map((c, i) => [c.id, vectors[pairs.length + i]]))
  console.log(`[router] ${slug}: ${pairs.length} Q/A pairs, ${facts.length} cards embedded in ${Date.now() - started}ms`)
  return { cards, pairs, pairVectors: vectors.slice(0, pairs.length), cardVectors }
}

function watchContext(slug: string) {
  if (watched.has(slug)) return
  const dir = join(engramDir(slug), 'context')
  if (!existsSync(dir)) return
  watched.add(slug)
  let timer: NodeJS.Timeout | undefined
  watch(dir, () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      banks.delete(slug)
      bank(slug).catch((e) => console.warn(`[router] reload failed: ${(e as Error).message}`))
    }, RELOAD_DEBOUNCE_MS)
  }).on('error', () => watched.delete(slug))
}
