import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { randomUUID } from 'node:crypto'
import { loadManifest } from '../lib/engram-store.ts'
import { sortedCards, writeCard } from '../lib/cards.ts'
import { streamChat, DEFAULT_MODEL, warmModel, type OllamaStats } from '../lib/liquid.ts'
import { streamChat as streamOpenRouter } from '../lib/direct/openrouter.ts'
import { buildTurn, pickCards, stripMarkdown, tokenize } from '../lib/prompt.ts'
import { searchWeb, type WebResult } from '../lib/nimble.ts'
import { logEvent } from '../lib/rawtree.ts'
import { writeLiveCards } from './context.ts'
import type { ChatEvent, ChatMessage, ContextCard } from '../../shared/types.ts'

export const chat = new Hono()

const MIN_SENTENCE = 12
const MAX_SENTENCES = 3
const FILLERS = ['Give me a second, let me look that up.', 'Hang on, let me check.', 'One sec, pulling that up.']
const SECOND_FILLER = 'Pulling it up now.'
const SECOND_FILLER_AFTER_MS = 1800
const MEMORY_LINES = 12
const MIN_UTTERANCE = 12
const TITLE_WORDS = 5
const THROWAWAY_SESSIONS = /^(test|curl|bench)/i
const MEMORY_ON = process.env.ENGRAM_MEMORY !== 'off'   // ENGRAM_MEMORY=off: never write memory cards (demo safety)
const WEB_TIMEOUT_MS = 6000
const SENTENCE_END = /(?<!\b[A-Z])[.!?]["')\]]*(?=\s|$)/g
const WEB_TRIGGERS = /\b(today|tonight|yesterday|tomorrow|latest|news|recent(ly)?|this (week|month|year|morning)|hackathon|weather|forecast|stock|price|score|happening|announced|released|launched|update|schedule|agenda|202[6-9])\b/i

chat.post('/:slug/chat', async (c) => {
  const slug = c.req.param('slug')
  const body = await c.req.json<{ messages?: ChatMessage[]; sessionId?: string }>().catch(() => ({}) as { messages?: ChatMessage[]; sessionId?: string })
  const messages = (body.messages ?? []).filter((m) => m?.content?.trim())
  const sessionId = body.sessionId ?? randomUUID()
  const question = [...messages].reverse().find((m) => m.role === 'user')?.content
  if (!question) return c.json({ error: 'messages must end with a user message' }, 400)
  let manifest
  try { manifest = loadManifest(slug) } catch (e) { return c.json({ error: (e as Error).message }, 404) }

  const started = Date.now()
  const turnId = randomUUID()
  const cards = sortedCards(slug)
  const wantsWeb = needsWeb(question, cards, manifest.name)
  const model = manifest.brain.model || DEFAULT_MODEL
  const brain = manifest.brain.provider === 'openrouter' ? streamOpenRouter : streamChat  // direct engrams answer via OpenRouter
  logEvent({ engram: slug, session: sessionId, turn: turnId, type: 'user_utterance', chars: question.length, text: question })

  return streamSSE(c, async (stream) => {
    const send = (event: ChatEvent) => stream.writeSSE({ data: JSON.stringify(event) })
    const splitter = sentenceSplitter()
    const spoken: string[] = []
    const say = (text: string) => {
      spoken.push(text)
      return send({ type: 'sentence', index: spoken.length - 1, text })
    }
    let firstTokenAt = 0
    let live: WebResult | undefined
    let stats: OllamaStats = {}

    if (wantsWeb) {
      await send({ type: 'context', cards: pickCards(cards, question, [memoryId(sessionId)]).map((c) => c.id), live: { query: question, urls: [] } })
      const filler = FILLERS[Math.floor(Math.random() * FILLERS.length)]
      await send({ type: 'token', text: `${filler} ` })
      await say(filler)
      const rich = searchWeb(question, 3, true, WEB_TIMEOUT_MS).catch(() => undefined)
      const fast = searchWeb(question, 3, false, WEB_TIMEOUT_MS).catch(() => undefined)
      const search = rich.then((r) => r ?? fast)
      const slow = await Promise.race([search.then(() => false), delay(SECOND_FILLER_AFTER_MS).then(() => true)])
      if (slow) {
        await send({ type: 'token', text: `${SECOND_FILLER} ` })
        await say(SECOND_FILLER)
      }
      live = await search
      if (live) logEvent({ engram: slug, session: sessionId, turn: turnId, type: 'context_web', ms: Date.now() - started, chars: live.hits.length, text: live.query, meta: { urls: live.hits.map((h) => h.url) } })
      if (live) try { writeLiveCards(slug, manifest.name, question, live) } catch {}
    }
    const { messages: turn, used } = buildTurn(manifest, cards, messages, question, live, [memoryId(sessionId)])
    await send({ type: 'context', cards: used, live: live && { query: live.query, urls: live.hits.map((h) => h.url) } })

    const abort = new AbortController()
    c.req.raw.signal.addEventListener('abort', () => abort.abort())
    try {
      const stream = brain === streamChat ? streamChat(model, turn, abort.signal, (s) => { stats = s }) : brain(model, turn, abort.signal)
      for await (const raw of stream) {
        const token = raw.replace(/[*#`]/g, '').replace(/\s*[—–]\s*|\s+-\s+/g, ', ').replace(/\n+/g, ' ')
        if (!token) continue
        if (!firstTokenAt) {
          firstTokenAt = Date.now()
          logEvent({ engram: slug, session: sessionId, turn: turnId, type: 'chat_first_token', ms: firstTokenAt - started, provider: model, meta: { web: !!live } })
        }
        await send({ type: 'token', text: token })
        for (const sentence of splitter.push(token)) if (spoken.length < MAX_SENTENCES) await say(sentence)
        if (spoken.length >= MAX_SENTENCES) break
      }
      if (!spoken.length || (spoken.length < MAX_SENTENCES && /[.!?]["')\]]*$/.test(splitter.peek()))) for (const sentence of splitter.flush()) await say(sentence)
    } catch (e) {
      if (!abort.signal.aborted) await send({ type: 'error', message: (e as Error).message })
    }
    abort.abort()

    const text = spoken.join(' ')
    const latencyMs = Date.now() - started
    const firstTokenMs = firstTokenAt ? firstTokenAt - started : null
    await send({ type: 'done', turnId, text, latencyMs })
    console.log(`[chat] first token ${firstTokenMs ?? '-'}ms, prompt ${stats.promptTokens ?? '-'} tok in ${stats.promptEvalMs ?? '-'}ms, ${stats.evalTokens ?? '-'} tok out in ${stats.evalMs ?? '-'}ms, total ${latencyMs}ms${live ? ', web' : ''}`)
    logEvent({ engram: slug, session: sessionId, turn: turnId, type: 'chat_done', ms: latencyMs, chars: text.length, provider: model, text, meta: { cards: used, firstTokenMs, sentences: spoken.length, web: live?.query ?? null, ...stats } })
    if (text && MEMORY_ON) setImmediate(() => saveMemory(slug, sessionId, messages, text, cards, used))
  })
})

function sentenceSplitter() {
  let pending = ''
  const cut = (s: string) => stripMarkdown(s)
  return {
    push(token: string): string[] {
      pending += token
      const out: string[] = []
      let match: RegExpExecArray | null
      let consumed = 0
      SENTENCE_END.lastIndex = 0
      while ((match = SENTENCE_END.exec(pending))) {
        const end = match.index + match[0].length
        const candidate = pending.slice(consumed, end).trim()
        if (candidate.length < MIN_SENTENCE) continue
        out.push(cut(candidate))
        consumed = end
      }
      pending = pending.slice(consumed)
      return out.filter(Boolean)
    },
    flush(): string[] {
      const rest = cut(pending)
      pending = ''
      return rest ? [rest] : []
    },
    peek: () => pending.trim(),
  }
}

function needsWeb(question: string, cards: ContextCard[], selfName: string) {
  if (WEB_TRIGGERS.test(question)) return true
  const firstName = selfName.split(' ')[0].toLowerCase()
  const subject = /\b(?:who|what)(?:'s|\s+is|\s+was|\s+are|\s+were)\s+(?:the\s+|a\s+|an\s+)?(.+?)\??$/i.exec(question)?.[1]
  if (!subject || /\b(you|your|yourself)\b/i.test(subject) || subject.toLowerCase().includes(firstName)) return false
  const terms = tokenize(subject)
  if (!terms.length) return false
  const known = new Set(cards.flatMap((card) => tokenize(`${card.title} ${card.body}`)))
  return terms.some((t) => !known.has(t))
}

function saveMemory(slug: string, sessionId: string, messages: ChatMessage[], answer: string, cards: ContextCard[], used: string[]) {
  if (THROWAWAY_SESSIONS.test(sessionId)) return
  const grounded = cards.some((c) => used.includes(c.id) && c.section !== 'memory' && c.section !== 'voice')
  if (!grounded || !mentionsProperNoun(answer, cards)) return
  const history = [...messages, { role: 'assistant' as const, content: answer }]
  const exchanges = history.flatMap((m, i) => {
    const reply = history[i + 1]?.role === 'assistant' ? withoutFiller(history[i + 1].content) : ''
    return m.role === 'user' && isRealUtterance(m.content) && reply ? [{ question: m.content, reply }] : []
  })
  if (!exchanges.length) return
  const date = new Date().toISOString().slice(0, 10)
  try {
    writeCard(slug, memoryId(sessionId), {
      section: 'memory',
      title: topicTitle(exchanges[0].question),
      source: `conversation ${date}`,
      body: exchanges
        .slice(-MEMORY_LINES)
        .map(({ question, reply }) => `- Asked "${oneLine(question, 90)}" and I said: ${wholeSentences(reply, 240)}`)
        .join('\n'),
    })
  } catch {}
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const PROPER_NOUN = /\b[A-Z][a-zA-Z0-9]{2,}\b/g

function mentionsProperNoun(answer: string, cards: ContextCard[]) {
  const known = new Set(cards.flatMap((c) => `${c.title} ${c.body}`.match(PROPER_NOUN) ?? []))
  const midSentence = answer.replace(/(^|[.!?]["')\]]*\s+)[A-Z][a-zA-Z0-9]*/g, '$1')
  return (midSentence.match(PROPER_NOUN) ?? []).some((w) => known.has(w))
}

const memoryId = (sessionId: string) => `memory-${sessionId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40)}`

const isRealUtterance = (s: string) => s.trim().length >= MIN_UTTERANCE && /[a-z]/i.test(s)

const withoutFiller = (s: string) =>
  FILLERS.reduce((out, filler) => out.split(filler).join(' '), s).replace(/\s+/g, ' ').trim()

const topicTitle = (question: string) =>
  question.replace(/\s+/g, ' ').trim().split(' ').slice(0, TITLE_WORDS).join(' ').replace(/[\s?!.,;:"']+$/, '')

const oneLine = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.lastIndexOf(' ', max - 1)
  return `${flat.slice(0, cut > max / 2 ? cut : max - 1)}…`
}

function wholeSentences(s: string, max: number) {
  const sentences = s.replace(/\s+/g, ' ').trim().split(/(?<=[.!?]["')\]]*)\s+/)
  let out = sentences[0] ?? ''
  for (const next of sentences.slice(1)) {
    if (out.length + next.length + 1 > max) break
    out += ` ${next}`
  }
  return out
}

export { needsWeb, sentenceSplitter }

warmModel(DEFAULT_MODEL)
