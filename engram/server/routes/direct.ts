// Direct avatar engram mode: POST a research record, get a folder the stage can talk to. See docs/direct-mode.md.
import { Hono } from 'hono'
import { writeDirectEngram } from '../lib/direct/person.ts'
import { DIRECT_MODEL, OPENROUTER_URL, lastStatus } from '../lib/direct/openrouter.ts'

export const direct = new Hono()

const MAX_PHOTO = 12 * 1024 * 1024
const MAX_CLIP = 60 * 1024 * 1024
const IMAGE_MAGIC: [Buffer, string][] = [[Buffer.from([0xff, 0xd8, 0xff]), '.jpg'], [Buffer.from('\x89PNG', 'latin1'), '.png'], [Buffer.from('RIFF'), '.webp']]

direct.get('/health', (c) => c.json({ ok: lastStatus.ok, model: DIRECT_MODEL, url: OPENROUTER_URL, detail: lastStatus.detail }))

// POST /api/direct/engrams  { name | full_name, ...record, posts?: [{url, snippet, platform, posted_at}], photo?: dataURI|url, clip?: dataURI|url }
direct.post('/engrams', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body || typeof body !== 'object') return c.json({ error: 'body must be a JSON object describing one person' }, 400)
  if (!String(body.name ?? body.full_name ?? '').trim()) return c.json({ error: 'name (or full_name) is required' }, 400)
  let photo, clip
  try {
    const raw = await asset(body.photo, MAX_PHOTO, 'photo')
    if (raw) {
      const ext = IMAGE_MAGIC.find(([magic]) => raw.subarray(0, magic.length).equals(magic))?.[1]
      if (!ext) return c.json({ error: 'photo must be a JPEG, PNG or WebP' }, 400)
      photo = { bytes: raw, ext }
    }
    clip = await asset(body.clip, MAX_CLIP, 'clip')
    if (clip && !clip.subarray(0, 16).includes('ftyp')) return c.json({ error: 'clip must be an mp4' }, 400)
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
  try {
    const result = writeDirectEngram(body, { photo, clip })
    return c.json({ ...result, mode: 'direct', url: `/e/${result.slug}` }, 201)
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500)
  }
})

async function asset(value: unknown, max: number, what: string): Promise<Buffer | undefined> {
  if (!value) return undefined
  const v = String(value)
  let bytes: Buffer
  if (v.startsWith('data:')) bytes = Buffer.from(v.slice(v.indexOf(',') + 1), 'base64')
  else if (/^https?:\/\//i.test(v)) {
    const r = await fetch(v, { signal: AbortSignal.timeout(30_000) })
    if (!r.ok) throw new Error(`could not fetch ${what} (${r.status})`)
    bytes = Buffer.from(await r.arrayBuffer())
  } else throw new Error(`${what} must be a data: URI or an http(s) URL`)
  if (bytes.length > max) throw new Error(`${what} is over ${Math.round(max / 1024 / 1024)} MB`)
  return bytes
}
