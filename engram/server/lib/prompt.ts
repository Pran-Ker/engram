import type { ChatMessage, ContextCard, EngramManifest } from '../../shared/types.ts'
import type { WebResult } from './nimble.ts'

export type PromptMessage = { role: 'system' | 'user' | 'assistant'; content: string }

const MAX_CARDS = 6
const CARD_CHARS = 450
const NOTES_CHARS = 2600
const HISTORY_TURNS = 6
const STOPWORDS = new Set('the a an and or but of to in on at for with about from by as is are was were be been being am do does did have has had you your yours yourself i me my we our us he him his she her it its they them their this that these those what which who whom whose when where why how tell say said think feel know like just really very some any all can could would should will shall may might one thing things something anything right now there here than then too also into over out up down off so if not no yes'.split(' '))

export const tokenize = (s: string) =>
  s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOPWORDS.has(w))

export function pickCards(cards: ContextCard[], question: string, excludeIds: string[] = []): ContextCard[] {
  const asked = new Set(tokenize(question))
  const facts = cards.filter((c) => c.section !== 'voice' && !excludeIds.includes(c.id))
  const scored = facts
    .map((card) => ({ card, score: relevance(card, asked) * (card.section === 'memory' ? 0.5 : 1) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
  const memories = scored.filter((s) => s.card.section === 'memory').slice(0, 1)
  const others = scored.filter((s) => s.card.section !== 'memory')
  const picked = [...others, ...memories].sort((a, b) => b.score - a.score).slice(0, MAX_CARDS).map((s) => s.card)
  return picked.length ? picked : defaults(facts)
}

function relevance(card: ContextCard, asked: Set<string>) {
  const title = tokenize(card.title)
  const body = tokenize(card.body)
  const titleHits = title.filter((w) => asked.has(w)).length
  const bodyHits = new Set(body.filter((w) => asked.has(w))).size
  return titleHits * 3 + bodyHits
}

const defaults = (cards: ContextCard[]) => [
  ...cards.filter((c) => c.id.startsWith('profile-01')),
  ...cards.filter((c) => c.id.startsWith('work-05')),
]

export function buildTurn(
  manifest: EngramManifest,
  cards: ContextCard[],
  history: ChatMessage[],
  question: string,
  live?: WebResult,
  excludeIds: string[] = [],
): { messages: PromptMessage[]; used: string[] } {
  const voice = cards.filter((c) => c.section === 'voice')
  let facts = pickCards(cards, question, excludeIds)
  let notes = renderNotes(manifest, facts, live)
  while (notes.length > NOTES_CHARS && facts.length > 1) {
    facts = facts.slice(0, -1)
    notes = renderNotes(manifest, facts, live)
  }
  const prior = history.slice(0, -1).slice(-HISTORY_TURNS)
  const messages: PromptMessage[] = [
    { role: 'system', content: renderSystem(manifest, voice) },
    ...fewShot(voice),
    ...prior,
    { role: 'user', content: `${notes}\n\n${question}` },
  ]
  return { messages, used: [...facts.map((c) => c.id), ...voice.map((c) => c.id)] }
}

function renderSystem(manifest: EngramManifest, voice: ContextCard[]) {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  return [
    manifest.brain.persona,
    `Today is ${today}.`,
    voice.length ? `How you talk:\n${voice.map(renderVoice).join('\n')}` : '',
    'Each question comes with notes about yourself. Use only what the notes say; if they do not cover it, say you do not know in one sentence. Never speculate about why things happened or about people and companies you worked with. Answer out loud in one to three short sentences, plain speech, no lists or markdown, never mention the notes. Every sentence is spoken aloud: keep each under twenty words, no dashes of any kind, no semicolons, no parentheses; use a comma or start a new sentence instead.',
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

const renderVoice = (card: ContextCard) =>
  `- ${card.title}: ${cutAtSentence(compact(withoutExamples(card.body)), CARD_CHARS)}`

const withoutExamples = (body: string) =>
  body.split('\n').filter((line) => !/^Q:\s/.test(line.trim())).join('\n')

export function fewShot(cards: ContextCard[]): ChatMessage[] {
  const lines = cards.filter((c) => c.section === 'voice').flatMap((c) => c.body.split('\n'))
  return lines.flatMap((line) => {
    const m = /^Q:\s*(.+?)\s+A:\s*(.+)$/.exec(line.trim())
    return m ? [{ role: 'user' as const, content: m[1] }, { role: 'assistant' as const, content: m[2] }] : []
  })
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
