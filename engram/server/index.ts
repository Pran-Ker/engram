import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { existsSync } from 'node:fs'
import { engrams } from './routes/engrams.ts'
import { chat } from './routes/chat.ts'
import { tts } from './routes/tts.ts'
import { context } from './routes/context.ts'
import { events } from './routes/events.ts'
import { inspect } from './routes/inspect.ts'
import { health } from './routes/health.ts'

export const PORT = Number(process.env.PORT ?? 4100)

const app = new Hono()
app.use('/api/*', cors())

app.route('/api/engrams', engrams)   // GET /, GET /:slug, GET /:slug/video/:clip
app.route('/api/engrams', chat)      // POST /:slug/chat  (SSE)
app.route('/api/engrams', tts)       // POST /:slug/tts   (audio/wav)
app.route('/api/engrams', context)   // GET /:slug/context, POST /:slug/context/web, POST /:slug/context
app.route('/api/events', events)     // POST /, GET /
app.route('/api/inspect', inspect)   // GET /:slug/runs, GET /:slug/turns, POST /:slug/flags ...
app.route('/api/health', health)     // GET /

// Review pages for Prannay: everything under review/ (clips, samples, batches).
app.use('/review/*', serveStatic({ root: './' }))
app.get('/review/:batch', (c) => c.redirect(`/review/${c.req.param('batch')}/index.html`))

// Production: serve the built web app. In dev, Vite (4173) proxies /api here.
if (existsSync('web/dist')) {
  app.use('/*', serveStatic({ root: './web/dist' }))
  app.get('*', serveStatic({ path: './web/dist/index.html' }))
}

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`engram server on http://localhost:${PORT}`)
})

// Docs as plain markdown so the stage can link to them (frontend workstream).
import { docs } from './routes/docs.ts'
app.route('/api/docs', docs)           // GET /, GET /:name.md
