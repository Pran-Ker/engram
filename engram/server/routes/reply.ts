// Spoken video replies: the dashboard (dashboard/dashboard.py) asks FLUX 3 to render the person's avatar saying an
// answer. This file is a thin proxy so the talk page stays on one origin and needs no CORS on the dashboard.
// DASHBOARD_URL points at it; when it is down every route here says so instead of failing the conversation.
import { Hono } from 'hono'

export const reply = new Hono()

export const DASHBOARD_URL = (process.env.DASHBOARD_URL ?? 'http://127.0.0.1:8765').replace(/\/$/, '')
const TIMEOUT_MS = 15_000
const CLIP_NAME = /^[\w.-]+\.mp4$/

type Job = { job?: string; status?: string; url?: string; error?: string; [k: string]: unknown }
type Person = { person_id: string; image: string }

const unreachable = `dashboard unreachable at ${DASHBOARD_URL}`
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const ownUrl = (slug: string, j: Job) => (j.url ? { ...j, url: `/api/engrams/${slug}/reply/clip/${j.url.split('/').pop()}` } : j)

// GET /api/engrams/:slug/reply/health   can this person be voiced by FLUX? (dashboard up, person known there, verified photo)
reply.get('/:slug/reply/health', async (c) => {
  const slug = c.req.param('slug')
  try {
    const r = await fetch(`${DASHBOARD_URL}/api/people`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!r.ok) return c.json({ ok: false, detail: `dashboard answered ${r.status}` })
    const person = ((await r.json()) as Person[]).find((p) => p.person_id === slug)
    if (!person) return c.json({ ok: false, detail: 'not a dashboard person' })
    if (!person.image) return c.json({ ok: false, detail: 'no verified photo on the dashboard' })
    return c.json({ ok: true, dashboard: DASHBOARD_URL })
  } catch {
    return c.json({ ok: false, detail: unreachable })
  }
})

// POST /api/engrams/:slug/reply { text, hd? }   starts (or reuses) a render; returns the dashboard's job record
reply.post('/:slug/reply', async (c) => {
  const slug = c.req.param('slug')
  const body = await c.req.json<{ text?: string; hd?: boolean }>().catch(() => ({}) as { text?: string; hd?: boolean })
  const text = String(body.text ?? '').trim()
  if (!text) return c.json({ error: 'text is required' }, 400)
  try {
    const r = await fetch(`${DASHBOARD_URL}/api/reply-clip/${encodeURIComponent(slug)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, hd: !!body.hd }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const j = (await r.json()) as Job
    return json(r.ok ? ownUrl(slug, j) : j, r.status)
  } catch {
    return c.json({ error: unreachable }, 502)
  }
})

// GET /api/engrams/:slug/reply?job=   poll a render
reply.get('/:slug/reply', async (c) => {
  const slug = c.req.param('slug')
  const job = c.req.query('job')
  if (!job) return c.json({ error: 'job is required' }, 400)
  try {
    const r = await fetch(`${DASHBOARD_URL}/api/reply-clip?job=${encodeURIComponent(job)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    const j = (await r.json()) as Job
    return json(r.ok ? ownUrl(slug, j) : j, r.status)
  } catch {
    return c.json({ error: unreachable }, 502)
  }
})

// GET /api/engrams/:slug/reply/clip/:file   the rendered mp4, streamed from the dashboard's videos/replies/
reply.get('/:slug/reply/clip/:file', async (c) => {
  const file = c.req.param('file')
  if (!CLIP_NAME.test(file)) return c.json({ error: 'bad clip name' }, 400)
  try {
    const r = await fetch(`${DASHBOARD_URL}/videos/replies/${file}`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!r.ok || !r.body) return c.json({ error: `clip not found (${r.status})` }, 404)
    const headers: Record<string, string> = { 'Content-Type': 'video/mp4', 'Cache-Control': 'private, max-age=86400' }
    const length = r.headers.get('content-length')
    if (length) headers['Content-Length'] = length
    return new Response(r.body, { headers })
  } catch {
    return c.json({ error: unreachable }, 502)
  }
})
