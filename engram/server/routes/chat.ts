import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { randomUUID } from 'node:crypto'
import { loadManifest } from '../lib/engram-store.ts'
import { writeCard } from '../lib/cards.ts'
import { streamChat, complete, DEFAULT_MODEL, warmModel, type OllamaStats } from '../lib/liquid.ts'
import { streamChat as streamOpenRouter } from '../lib/direct/openrouter.ts'
import { ABSTAIN, buildTurn, isAbstain, pickCards, stripMarkdown, tokenize, unknownFacts } from '../lib/prompt.ts'
import { bank, matchQuestion, QA_THRESHOLD } from '../lib/router.ts'
import { searchWeb, type WebResult } from '../lib/nimble.ts'
import { logEvent } from '../lib/rawtree.ts'
import { writeLiveCards } from './context.ts'
import type { ChatEvent, ChatMessage, ContextCard, EngramManifest } from '../../shared/types.ts'

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
const SENTENCE_END_FIRST = /(?<!\b[A-Z])[.!?]["')\]]*(?=\s|$)/
const CLAUSE_END = /[,;](?=\s)/g
const CLAUSE_WORDS = 7
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
  const model = manifest.brain.model || DEFAULT_MODEL
  logEvent({ engram: slug, session: sessionId, turn: turnId, type: 'user_utterance', chars: question.length, text: question })
  const [qaBank, { vector, best }] = await Promise.all([bank(slug), matchQuestion(slug, question)])
  const cards = qaBank.cards
  const hit = best && best.similarity >= QA_THRESHOLD ? best : undefined

  return streamSSE(c, async (stream) => {
    const send = (event: ChatEvent) => stream.writeSSE({ data: JSON.stringify(event) })
    const spoken: string[] = []
    const say = (text: string) => {
      spoken.push(text)
      return send({ type: 'sentence', index: spoken.length - 1, text })
    }

    if (hit) {
      await send({ type: 'context', cards: [hit.pair.cardId] })
      await send({ type: 'token', text: hit.pair.a })
      const splitter = sentenceSplitter()
      for (const fragment of [...splitter.push(hit.pair.a), ...splitter.flush()]) await say(fragment)
      const latencyMs = Date.now() - started
      await send({ type: 'done', turnId, text: hit.pair.a, latencyMs })
      console.log(`[chat] qa route, similarity ${hit.similarity.toFixed(3)} "${hit.pair.q}", total ${latencyMs}ms`)
      logEvent({ engram: slug, session: sessionId, turn: turnId, type: 'chat_done', ms: latencyMs, chars: hit.pair.a.length, provider: 'qa-bank', text: hit.pair.a, meta: { route: 'qa', similarity: hit.similarity, matched: hit.pair.q, cards: [hit.pair.cardId], sentences: spoken.length } })
      return
    }

    const wantsWeb = needsWeb(question, cards, manifest.name)
    const brain = manifest.brain.provider === 'openrouter' ? streamOpenRouter : streamChat
    const exclude = [memoryId(sessionId)]
    let firstTokenAt = 0
    let live: WebResult | undefined
    let stats: OllamaStats = {}
    let factcheck: Factcheck = 'ok'

    if (wantsWeb) {
      await send({ type: 'context', cards: pickCards(cards, question, exclude, qaBank, vector).map((c) => c.id), live: { query: question, urls: [] } })
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
    const { messages: turn, used } = buildTurn(manifest, cards, messages, question, qaBank, vector, live, exclude)
    await send({ type: 'context', cards: used, live: live && { query: live.query, urls: live.hits.map((h) => h.url) } })
    const known = knownText(manifest, cards, question, live)
    const fillers = spoken.length

    const abort = new AbortController()
    c.req.raw.signal.addEventListener('abort', () => abort.abort())
    let sentences = 0
    let held = ''
    let pendingFirst: string[] = []
    const emit = async (fragment: string) => {
      if (held) await send({ type: 'token', text: held })
      held = ''
      await say(fragment)
      if (endsSentence(fragment)) sentences++
    }
    // hold the first sentence's clauses until it ends, so a failed check never leaves half a sentence spoken
    const deliver = async (fragment: string) => {
      if (sentences >= MAX_SENTENCES) return true
      const firstOpen = sentences === 0 && !endsSentence(fragment)
      if (firstOpen) { pendingFirst.push(fragment); return true }
      const check = sentences === 0 ? [...pendingFirst, fragment].join(' ') : fragment
      const unknown = isAbstain(check) ? [] : unknownFacts(check, known)
      if (unknown.length) {
        console.log(`[chat] factcheck failed on "${check}": ${unknown.join(', ')}`)
        return false
      }
      for (const held of pendingFirst) await emit(held)
      pendingFirst = []
      await emit(fragment)
      return true
    }
    try {
      const splitter = sentenceSplitter()
      const stream = brain === streamChat ? streamChat(model, turn, abort.signal, (s) => { stats = s }) : brain(model, turn, abort.signal)
      let ok = true
      for await (const raw of stream) {
        const token = cleanToken(raw)
        if (!token) continue
        if (!firstTokenAt) {
          firstTokenAt = Date.now()
          logEvent({ engram: slug, session: sessionId, turn: turnId, type: 'chat_first_token', ms: firstTokenAt - started, provider: model, meta: { web: !!live } })
        }
        held += token
        for (const fragment of splitter.push(token)) ok = ok && await deliver(fragment)
        if (!ok || sentences >= MAX_SENTENCES) break
      }
      if (ok && (spoken.length === fillers || (sentences < MAX_SENTENCES && /[.!?]["')\]]*$/.test(splitter.peek())))) for (const fragment of splitter.flush()) ok = ok && await deliver(fragment)
      if (ok && pendingFirst.length) ok = await deliver(`${pendingFirst.pop()}.`)
      abort.abort()
      if (!ok && spoken.length > fillers) factcheck = 'cut'
      if (!ok && spoken.length === fillers) {
        const retry = cleanToken((await complete(model, turn, c.req.raw.signal, { temperature: 0.05 })).text)
        const unknown = isAbstain(retry) ? [] : unknownFacts(retry, known)
        factcheck = unknown.length ? 'abstain' : 'regen'
        const text = unknown.length ? ABSTAIN : retry
        if (unknown.length) console.log(`[chat] factcheck failed again on "${retry}": ${unknown.join(', ')}`)
        await send({ type: 'token', text })
        const again = sentenceSplitter()
        for (const fragment of [...again.push(text), ...again.flush()]) if (sentences < MAX_SENTENCES) { await say(fragment); if (endsSentence(fragment)) sentences++ }
      }
    } catch (e) {
      if (!abort.signal.aborted) await send({ type: 'error', message: (e as Error).message })
    }
    abort.abort()

    const text = spoken.join(' ')
    const latencyMs = Date.now() - started
    const firstTokenMs = firstTokenAt ? firstTokenAt - started : null
    await send({ type: 'done', turnId, text, latencyMs })
    console.log(`[chat] llm route, first token ${firstTokenMs ?? '-'}ms, prompt ${stats.promptTokens ?? '-'} tok in ${stats.promptEvalMs ?? '-'}ms, ${stats.evalTokens ?? '-'} tok out in ${stats.evalMs ?? '-'}ms, factcheck ${factcheck}, total ${latencyMs}ms${live ? ', web' : ''}${best ? `, nearest qa ${best.similarity.toFixed(3)}` : ''}`)
    logEvent({ engram: slug, session: sessionId, turn: turnId, type: 'chat_done', ms: latencyMs, chars: text.length, provider: model, text, meta: { route: 'llm', similarity: best?.similarity ?? null, factcheck, cards: used, firstTokenMs, sentences: spoken.length, web: live?.query ?? null, ...stats } })
    if (text && MEMORY_ON && factcheck === 'ok') setImmediate(() => saveMemory(slug, sessionId, messages, text, cards, used))
  })
})

type Factcheck = 'ok' | 'regen' | 'abstain' | 'cut'

const cleanToken = (raw: string) => raw.replace(/[*#`]/g, '').replace(/\s*[—–]\s*|\s+-\s+/g, ', ').replace(/\n+/g, ' ')

const endsSentence = (fragment: string) => /[.!?]["')\]]*$/.test(fragment)

const knownText = (manifest: EngramManifest, cards: ContextCard[], question: string, live?: WebResult) =>
  [manifest.name, manifest.brain.persona, question, ...cards.map((c) => `${c.title} ${c.body}`), live?.answer ?? '', ...(live?.hits.map((h) => `${h.title} ${h.snippet}`) ?? [])].join('\n')

function sentenceSplitter() {
  let pending = ''
  let first = true
  const cut = (s: string) => stripMarkdown(s)
  return {
    push(token: string): string[] {
      pending += token
      const out: string[] = []
      let consumed = 0
      if (first) {
        const clause = clauseCut(pending)
        if (clause > 0) {
          out.push(cut(pending.slice(0, clause)))
          consumed = clause
          first = false
        }
      }
      let match: RegExpExecArray | null
      SENTENCE_END.lastIndex = consumed
      while ((match = SENTENCE_END.exec(pending))) {
        const end = match.index + match[0].length
        const candidate = pending.slice(consumed, end).trim()
        if (candidate.length < MIN_SENTENCE) continue
        out.push(cut(candidate))
        consumed = end
        first = false
      }
      pending = pending.slice(consumed)
      return out.filter(Boolean)
    },
    flush(): string[] {
      const rest = cut(pending)
      pending = ''
      first = false
      return rest ? [rest] : []
    },
    peek: () => pending.trim(),
  }
}

// First sentence only: cut at the first comma or semicolon after 7+ words, unless a sentence ends first
function clauseCut(text: string) {
  const sentenceEnd = text.search(SENTENCE_END_FIRST)
  CLAUSE_END.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = CLAUSE_END.exec(text))) {
    if (sentenceEnd >= 0 && match.index > sentenceEnd) return -1
    if (text.slice(0, match.index).trim().split(/\s+/).length >= CLAUSE_WORDS) return match.index + 1
  }
  return -1
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
