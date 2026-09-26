import { Hono } from 'hono'
import { existsSync, createReadStream, statSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { listEngrams, loadManifest, loadCards, engramDir } from '../lib/engram-store.ts'

export const engrams = new Hono()

engrams.get('/', (c) => c.json(listEngrams()))

engrams.get('/:slug', (c) => {
  const slug = c.req.param('slug')
  try {
    const manifest = loadManifest(slug)
    return c.json({ ...manifest, cards: loadCards(slug).length })
  } catch (e) {
    return c.json({ error: (e as Error).message }, 404)
  }
})

// GET /api/engrams/:slug/video/:clip   clip = idle | talk | poster | intro (direct mode only: the source clip with its audio)
engrams.get('/:slug/video/:clip', (c) => {
  const slug = c.req.param('slug')
  const clip = c.req.param('clip') as 'idle' | 'talk' | 'poster' | 'intro'
  let m
  try { m = loadManifest(slug) } catch (e) { return c.json({ error: (e as Error).message }, 404) }
  const rel = clip === 'intro' ? m.intro?.video : m.video[clip]
  if (!rel) return c.json({ error: `unknown clip ${clip}` }, 404)
  const p = join(engramDir(slug), rel)
  if (!existsSync(p)) return c.json({ error: `clip not generated yet: ${rel}` }, 404)
  const size = statSync(p).size
  const type = p.endsWith('.mp4') ? 'video/mp4' : p.endsWith('.webm') ? 'video/webm' : 'image/jpeg'
  const range = c.req.header('range')
  if (range) {
    const [s, e] = range.replace('bytes=', '').split('-')
    const start = Number(s)
    const end = e ? Number(e) : size - 1
    const stream = Readable.toWeb(createReadStream(p, { start, end })) as ReadableStream
    return new Response(stream, {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
      },
    })
  }
  const stream = Readable.toWeb(createReadStream(p)) as ReadableStream
  return new Response(stream, { headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } })
})
