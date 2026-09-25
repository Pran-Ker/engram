import { RawTree } from '@rawtree/sdk'
import type { EventRow } from '../../shared/types.ts'
import { isoDate } from './cards.ts'

export const TABLE = 'lh_engram_events'
const FLUSH_MS = 2000
const FLUSH_ROWS = 20
const TEXT_CHARS = 500
const DEDUPE_MS = 5000

type StoredRow = Omit<EventRow, 'meta'> & { meta?: string }
type FlatRow = Record<string, string | number | boolean | null>

let client: RawTree | undefined
let buffer: StoredRow[] = []
let timer: NodeJS.Timeout | undefined
const recent = new Map<string, StoredRow>()
export let lastStatus = { ok: false, detail: process.env.RAWTREE_API_KEY ? 'key present, no flush yet' : 'RAWTREE_API_KEY missing' }

function getClient() {
  if (!process.env.RAWTREE_API_KEY) throw new Error('RAWTREE_API_KEY missing')
  client ??= new RawTree({ apiKey: process.env.RAWTREE_API_KEY, database: process.env.RAWTREE_DATABASE ?? 'default' })
  return client
}

export function logEvent(row: Omit<EventRow, 'ts'> & { ts?: string }) {
  const stored: StoredRow = {
    ...row,
    ts: row.ts ?? new Date().toISOString(),
    text: row.text?.slice(0, TEXT_CHARS),
    meta: row.meta ? JSON.stringify(row.meta) : undefined,
  }
  if (row.type === 'user_utterance' && mergeDuplicate(stored)) return
  buffer.push(stored)
  if (buffer.length >= FLUSH_ROWS) return void flush()
  timer ??= setTimeout(flush, FLUSH_MS).unref?.() ?? undefined
}

function mergeDuplicate(row: StoredRow) {
  const now = Date.parse(row.ts)
  for (const [key, old] of recent) if (now - Date.parse(old.ts) > DEDUPE_MS) recent.delete(key)
  const key = `${row.engram}|${row.session}|${row.text}`
  const old = recent.get(key)
  if (!old) return void recent.set(key, row)
  old.turn ??= row.turn
  return true
}

export async function flush() {
  if (timer) clearTimeout(timer)
  timer = undefined
  if (!buffer.length) return
  const rows = buffer
  buffer = []
  try {
    await getClient().insert({ table: TABLE, values: rows.map(flatten), signal: AbortSignal.timeout(8000) })
    lastStatus = { ok: true, detail: `flushed ${rows.length} rows at ${new Date().toISOString()}` }
  } catch (e) {
    lastStatus = { ok: false, detail: (e as Error).message }
  }
}

const flatten = (row: StoredRow): FlatRow =>
  Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)) as FlatRow

export async function queryEvents(filter: { engram?: string; since?: string; limit?: number }): Promise<EventRow[]> {
  const where = [
    filter.engram && `engram = ${quote(filter.engram)}`,
    filter.since && `ts > ${quote(filter.since)}`,
  ].filter(Boolean)
  const limit = Math.min(Math.max(Number(filter.limit) || 200, 1), 2000)
  const sql = `SELECT * FROM ${TABLE}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ts DESC LIMIT ${limit}`
  const r = await getClient().query<StoredRow>({ sql, signal: AbortSignal.timeout(8000) })
  return r.data.map(unflatten)
}

const unflatten = (row: StoredRow): EventRow => ({
  ...row,
  ts: isoDate(row.ts),
  meta: parseMeta(row.meta),
})

function parseMeta(meta?: string) {
  if (!meta) return undefined
  try { return JSON.parse(meta) as Record<string, unknown> } catch { return { raw: meta } }
}

export async function ping(): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await getClient().query({ sql: 'SELECT 1 AS one', signal: AbortSignal.timeout(5000) })
    return { ok: r.rows >= 1, detail: `SELECT 1 in ${Math.round(r.statistics.elapsed * 1000)} ms; ${lastStatus.detail}` }
  } catch (e) {
    return { ok: false, detail: (e as Error).message }
  }
}

const quote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
