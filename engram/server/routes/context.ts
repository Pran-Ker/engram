import { Hono } from 'hono'
import { loadManifest } from '../lib/engram-store.ts'
import { sortedCards, writeCard, slugify, timestampId, SECTION_ORDER } from '../lib/cards.ts'
import { searchWeb, clampTitle, hostname, type WebHit } from '../lib/nimble.ts'
import { logEvent } from '../lib/rawtree.ts'
import type { ContextCard, ContextSection } from '../../shared/types.ts'

export const context = new Hono()

context.get('/:slug/context', (c) => {
  const slug = c.req.param('slug')
  if (!exists(slug)) return c.json({ error: `no engram ${slug}` }, 404)
  return c.json(sortedCards(slug))
})

context.post('/:slug/context/web', async (c) => {
  const slug = c.req.param('slug')
  if (!exists(slug)) return c.json({ error: `no engram ${slug}` }, 404)
  const { query } = await c.req.json<{ query?: string }>().catch(() => ({ query: '' }))
  if (!query?.trim()) return c.json({ error: 'query is required' }, 400)

  const started = Date.now()
  let result
  try { result = await searchWeb(query.trim(), 3, true) } catch (e) { return c.json({ error: `web search failed: ${(e as Error).message}` }, 502) }

  const { name } = loadManifest(slug)
  const hits = uniqueByUrl(result.hits)
  const kept = hits.filter((hit) => hit.snippet && mentions(`${hit.title} ${hit.snippet}`, name))
  const answer = result.answer && mentions(result.answer, name) ? result.answer : undefined
  if (!kept.length && !answer) return c.json({ error: `the web had nothing usable about ${name} on that` }, 404)

  const existing = new Map(sortedCards(slug).filter((card) => card.section === 'live' && !card.id.startsWith('live-answer-')).map((card) => [card.source, card.id]))
  const stamp = timestampId()
  const cards: ContextCard[] = kept.map((hit, i) =>
    writeCard(slug, existing.get(hit.url) ?? `live-${stamp}-${i}-${slugify(hit.title)}`, {
      section: 'live',
      title: hit.title,
      body: hit.snippet,
      source: hit.url,
    }),
  )
  if (answer && kept[0]) cards.unshift(writeCard(slug, `live-answer-${slugify(query)}`, {
    section: 'live',
    title: clampTitle(query.trim()),
    body: answer,
    source: `web: ${[...new Set(hits.map((hit) => hostname(hit.url)))].join(', ')}`,
  }))
  logEvent({ engram: slug, session: c.req.header('x-session-id') ?? 'context-bank', type: 'context_web', ms: Date.now() - started, chars: cards.length, text: query, meta: { urls: cards.map((card) => card.source), dropped: hits.length - kept.length } })
  return c.json(cards)
})

context.post('/:slug/context', async (c) => {
  const slug = c.req.param('slug')
  if (!exists(slug)) return c.json({ error: `no engram ${slug}` }, 404)
  const body = await c.req.json<Partial<ContextCard>>().catch(() => ({}) as Partial<ContextCard>)
  const section = body.section as ContextSection
  if (!SECTION_ORDER.includes(section)) return c.json({ error: `section must be one of ${SECTION_ORDER.join(', ')}` }, 400)
  if (!body.title?.trim() || !body.body?.trim()) return c.json({ error: 'title and body are required' }, 400)
  const id = body.id?.trim() ? slugify(body.id, 80) : `${section}-${timestampId()}-${slugify(body.title)}`
  return c.json(writeCard(slug, id, { section, title: body.title.trim(), body: body.body, source: body.source?.trim() || 'added by hand' }), 201)
})

const mentions = (text: string, name: string) => {
  const haystack = text.toLowerCase()
  const [first] = name.toLowerCase().split(/\s+/)
  return haystack.includes(name.toLowerCase()) || haystack.includes(first)
}

const uniqueByUrl = (hits: WebHit[]) => {
  const seen = new Set<string>()
  return hits.filter((hit) => !seen.has(hit.url) && seen.add(hit.url))
}

function exists(slug: string) {
  try { loadManifest(slug); return true } catch { return false }
}
