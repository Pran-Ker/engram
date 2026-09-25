import { Hono } from 'hono'
import { logEvent, queryEvents } from '../lib/rawtree.ts'
import type { EventRow } from '../../shared/types.ts'

export const events = new Hono()

const TYPES = new Set<EventRow['type']>(['session_start', 'user_utterance', 'chat_first_token', 'chat_done', 'tts_done', 'tts_fallback', 'video_state', 'context_web', 'inspect_flag'])

events.post('/', async (c) => {
  const row = await c.req.json<Partial<EventRow>>().catch(() => ({}) as Partial<EventRow>)
  if (!row.engram || !row.session || !row.type) return c.json({ error: 'engram, session and type are required' }, 400)
  if (!TYPES.has(row.type)) return c.json({ error: `unknown type ${row.type}` }, 400)
  logEvent({
    engram: row.engram,
    session: row.session,
    turn: row.turn,
    type: row.type,
    ms: numberOrUndefined(row.ms),
    provider: row.provider,
    chars: numberOrUndefined(row.chars),
    text: row.text,
    meta: row.meta,
  })
  return c.json({ ok: true })
})

events.get('/', async (c) => {
  const { engram, since, limit } = c.req.query()
  try {
    return c.json(await queryEvents({ engram, since, limit: limit ? Number(limit) : undefined }))
  } catch (e) {
    return c.json({ error: `RawTree query failed: ${(e as Error).message}` }, 502)
  }
})

const numberOrUndefined = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
