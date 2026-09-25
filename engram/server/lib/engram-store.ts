import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import matter from 'gray-matter'
import type { EngramManifest, EngramSummary, ContextCard, ContextSection } from '../../shared/types.ts'

export const ENGRAMS_DIR = resolve(process.env.ENGRAMS_DIR ?? 'engrams')

export function listEngrams(): EngramSummary[] {
  if (!existsSync(ENGRAMS_DIR)) return []
  return readdirSync(ENGRAMS_DIR)
    .filter((d) => existsSync(join(ENGRAMS_DIR, d, 'engram.json')))
    .map((slug) => {
      const m = loadManifest(slug)
      const cards = loadCards(slug)
      return {
        slug: m.slug,
        name: m.name,
        tagline: m.tagline,
        cards: cards.length,
        ready: {
          voice: true,
          video: existsSync(join(ENGRAMS_DIR, slug, m.video.idle)),
          context: cards.length > 0,
        },
      }
    })
}

export function engramDir(slug: string) {
  return join(ENGRAMS_DIR, slug)
}

export function loadManifest(slug: string): EngramManifest {
  const p = join(ENGRAMS_DIR, slug, 'engram.json')
  if (!existsSync(p)) throw new Error(`no engram at ${p}`)
  return JSON.parse(readFileSync(p, 'utf8'))
}

export function loadCards(slug: string): ContextCard[] {
  const dir = join(ENGRAMS_DIR, slug, 'context')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => {
      const raw = readFileSync(join(dir, f), 'utf8')
      const { data, content } = matter(raw)
      return {
        id: f.replace(/\.md$/, ''),
        section: (data.section ?? 'profile') as ContextSection,
        title: String(data.title ?? f),
        body: content.trim(),
        source: String(data.source ?? ''),
        updatedAt: data.updatedAt ? String(data.updatedAt) : statSync(join(dir, f)).mtime.toISOString(),
      }
    })
}
