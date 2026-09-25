import { Hono } from 'hono'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const DOCS_DIR = 'docs'

const listDocs = () => (existsSync(DOCS_DIR) ? readdirSync(DOCS_DIR).filter((f) => f.endsWith('.md')) : [])

export const docs = new Hono()

docs.get('/', (c) => c.text(listDocs().join('\n') + '\n'))

docs.get('/:name', (c) => {
  const name = basename(c.req.param('name'))
  const file = join(DOCS_DIR, name)
  if (!name.endsWith('.md') || !existsSync(file))
    return c.text(`No doc called ${name} yet.\n\nAvailable:\n${listDocs().map((f) => `  /api/docs/${f}`).join('\n')}\n`, 404)
  return c.text(readFileSync(file, 'utf8'), 200, { 'Content-Type': 'text/markdown; charset=utf-8' })
})
