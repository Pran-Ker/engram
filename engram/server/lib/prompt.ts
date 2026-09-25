import type { ChatMessage, ContextCard, EngramManifest } from '../../shared/types.ts'
import type { WebResult } from './nimble.ts'
import { cardSimilarity, closestPairs, type Bank } from './router.ts'
import { cosine } from './embed.ts'

export type PromptMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export const ABSTAIN = "I don't have that in my notes."
const MAX_CARDS = 3
const CARD_CHARS = 220
const NOTES_CHARS = 700
const VOICE_BULLETS = 2
const VOICE_CHARS = 120
const FEWSHOT_PAIRS = 5
const FEWSHOT_CHARS = 400
const ABSTAIN_BELOW = 0.5
const ABSTAIN_EXAMPLE = { q: "What's your favorite movie?", a: ABSTAIN }
const HISTORY_MESSAGES = 4
const MIN_CARD_SIMILARITY = 0.25
const RULES = `Each question comes with notes about yourself. Use only what the notes say. If none of the notes or examples answers the question, say exactly: ${ABSTAIN} Do not invent names, numbers, dates, places or opinions. When a note or example already answers the question, repeat it as written. Speak in one to three short sentences, under twenty words each, no lists or markdown, never mention the notes, no dashes or parentheses.`
const STOPWORDS = new Set('the a an and or but of to in on at for with about from by as is are was were be been being am do does did have has had you your yours yourself i me my we our us he him his she her it its they them their this that these those what which who whom whose when where why how tell say said think feel know like just really very some any all can could would should will shall may might one thing things something anything right now there here than then too also into over out up down off so if not no yes'.split(' '))

export const tokenize = (s: string) =>
  s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOPWORDS.has(w))

const FORCED: [RegExp, (card: ContextCard) => boolean][] = [
  [/\b(working|building|right now|these days|up to)\b/i, (c) => c.id.startsWith('work-00')],
  [/\b(school|college|university|degree|study|studied|education)\b/i, (c) => c.id.startsWith('profile-02')],
  [/\bhow did you get into\b/i, (c) => c.section === 'story'],
  [/\bhexo\b/i, (c) => c.id.startsWith('work-03')],
]

export function pickCards(
  cards: ContextCard[],
  question: string,
  excludeIds: string[],
  bank: Bank,
  vector: number[],
): ContextCard[] {
  const facts = cards.filter((c) => c.section !== 'voice' && !excludeIds.includes(c.id))
  const forced = FORCED.flatMap(([re, match]) => (re.test(question) ? facts.filter(match) : []))
  const scored = facts
    .filter((c) => !forced.includes(c))
    .map((card) => ({ card, score: cardSimilarity(bank, vector, card) * (card.section === 'memory' ? 0.8 : 1) }))
    .filter((s) => s.score >= MIN_CARD_SIMILARITY)
    .sort((a, b) => b.score - a.score)
  const memories = scored.filter((s) => s.card.section === 'memory').slice(0, 1)
  const others = scored.filter((s) => s.card.section !== 'memory')
  const ranked = [...others, ...memories].sort((a, b) => b.score - a.score).map((s) => s.card)
  const picked = [...new Set([...forced, ...ranked])].slice(0, MAX_CARDS)
  return picked.length ? picked : defaults(facts)
}

const defaults = (cards: ContextCard[]) => [
  ...cards.filter((c) => c.id.startsWith('profile-01')),
  ...cards.filter((c) => c.id.startsWith('work-00')),
].slice(0, MAX_CARDS)

export function buildTurn(
  manifest: EngramManifest,
  cards: ContextCard[],
  history: ChatMessage[],
  question: string,
  bank: Bank,
  vector: number[],
  live?: WebResult,
  excludeIds: string[] = [],
): { messages: PromptMessage[]; used: string[] } {
  const voice = cards.filter((c) => c.section === 'voice')
  let facts = pickCards(cards, question, excludeIds, bank, vector)
  let notes = renderNotes(manifest, facts, live)
  while (notes.length > NOTES_CHARS && facts.length > 1) {
    facts = facts.slice(0, -1)
    notes = renderNotes(manifest, facts, live)
  }
  const prior = history.slice(0, -1).slice(-HISTORY_MESSAGES)
  const messages: PromptMessage[] = [
    { role: 'system', content: renderSystem(manifest, voice) },
    ...fewShot(bank, vector),
    ...prior,
    { role: 'user', content: `${today()}\n\n${notes}\n\n${question}` },
  ]
  return { messages, used: [...facts.map((c) => c.id), ...voice.map((c) => c.id)] }
}

const today = () =>
  `Today is ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}.`

function renderSystem(manifest: EngramManifest, voice: ContextCard[]) {
  const bullets = voice.map(renderVoice).filter(Boolean).slice(0, VOICE_BULLETS)
  return [
    manifest.brain.persona,
    bullets.length ? `How you talk:\n${bullets.join('\n')}` : '',
    RULES,
  ].filter(Boolean).join('\n\n')
}

function renderNotes(manifest: EngramManifest, facts: ContextCard[], live?: WebResult) {
  return [
    `Notes about yourself (${manifest.name}), in your own words:\n${facts.map(renderCard).join('\n')}`,
    live ? renderLive(live) : '',
  ].filter(Boolean).join('\n\n')
}

const renderCard = (card: ContextCard) => {
  const line = `- ${card.title}: ${cutAtSentence(compact(card.body), CARD_CHARS)}`
  return card.section === 'memory' ? line : firstPerson(line)
}

const PRONOUNS: [RegExp, string][] = [
  [/\bPrannay Hebbar's\b/g, 'my'],
  [/\bPrannay's\b/g, 'my'],
  [/\bPrannay Hebbar\b/g, 'I'],
  [/\bPrannay\b/g, 'I'],
  [/\b[Hh]e's\b/g, "I'm"],
  [/\bHe\b/g, 'I'],
  [/\bhe\b/g, 'I'],
  [/\bHis\b/g, 'My'],
  [/\bhis\b/g, 'my'],
  [/\bhimself\b/g, 'myself'],
  [/\bhim\b/g, 'me'],
  [/\bI is\b/g, 'I am'],
  [/\bI has\b/g, 'I have'],
  [/\bI does\b/g, 'I do'],
  [/\bI (work|live|call|treat|speak|keep|tell|read|listen|track|say|think|take|want|play|build|like|come|go|hold|run|sit|lead|write|cut|get|make|see|know|believe|argue|consider|describe|prefer|reach|use|own)(?:s|es)\b/g, 'I $1'],
]

export const firstPerson = (text: string) =>
  PRONOUNS.reduce((out, [re, sub]) => out.replace(re, sub), text)

const renderVoice = (card: ContextCard) => {
  const style = cutAtSentence(compact(withoutExamples(card.body)), VOICE_CHARS)
  return style ? `- ${style}` : ''
}

const withoutExamples = (body: string) =>
  body.split('\n').filter((line) => !/^Q:\s/.test(line.trim())).join('\n')

export function fewShot(bank: Bank, vector: number[]): ChatMessage[] {
  const pairs: { q: string; a: string }[] = []
  let chars = 0
  const closest = closestPairs(bank, vector, FEWSHOT_PAIRS)
  const nearest = closest[0] ? cosine(vector, bank.pairVectors[bank.pairs.indexOf(closest[0])]) : 0
  if (nearest < ABSTAIN_BELOW) pairs.push(ABSTAIN_EXAMPLE)
  for (const pair of closest) {
    chars += pair.q.length + pair.a.length
    if (pairs.length && chars > FEWSHOT_CHARS) break
    pairs.push(pair)
  }
  return pairs.reverse().flatMap(({ q, a }) => [{ role: 'user' as const, content: q }, { role: 'assistant' as const, content: a }])
}

function cutAtSentence(text: string, max: number) {
  if (text.length <= max) return text
  const head = text.slice(0, max)
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('; '))
  return end > max / 2 ? head.slice(0, end + 1) : head
}

const compact = (body: string) =>
  body.replace(/\n\s*[-*]\s+/g, '; ').replace(/\s*\n+\s*/g, ' ').replace(/\s+/g, ' ').trim()

function renderLive(live: WebResult) {
  const lines = live.answer
    ? [`- ${cutAtSentence(live.answer, 600)}`]
    : live.hits.map((h) => `- ${h.title}: ${h.snippet}`)
  return `You just looked this up on the web (you already said you would check, so now just say what you found, no URLs):\n${lines.join('\n')}`
}

const PROPER_NOUN = /\b[A-Z][a-zA-Z0-9]{2,}\b/g
const NUMBER = /\d[\d,.]*\d|\d/g
const SENTENCE_START = /(^|[.!?]["')\]]*\s+)([A-Z][a-zA-Z0-9]*)(?!\s+[A-Z])/g

export const isAbstain = (answer: string) => answer.trim().toLowerCase().startsWith(ABSTAIN.toLowerCase().slice(0, 12))

export function unknownFacts(answer: string, knownText: string): string[] {
  const known = knownText.toLowerCase()
  const knownNumbers = new Set(known.match(NUMBER)?.map(normalizeNumber) ?? [])
  const midSentence = answer.replace(SENTENCE_START, '$1')
  const nouns = (midSentence.match(PROPER_NOUN) ?? []).filter((w) => !known.includes(w.toLowerCase()))
  const numbers = (answer.match(NUMBER) ?? []).filter((n) => !knownNumbers.has(normalizeNumber(n)))
  return [...new Set([...nouns, ...numbers])]
}

const normalizeNumber = (n: string) => n.replace(/[,.]+$/, '').replace(/,/g, '')

export const stripMarkdown = (s: string) =>
  s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$|[.,!?])/g, '$1$2')
    .replace(/[*#`]/g, '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
