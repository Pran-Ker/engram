import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import matter from 'gray-matter'
import { engramDir, loadCards } from './engram-store.ts'
import type { ContextCard, ContextSection } from '../../shared/types.ts'

export const SECTION_ORDER: ContextSection[] = ['profile', 'story', 'work', 'opinions', 'voice', 'memory', 'live']

export function sortedCards(slug: string): ContextCard[] {
  return loadCards(slug)
    .map((card) => ({ ...card, updatedAt: isoDate(card.updatedAt) }))
    .sort((a, b) => sectionRank(a.section) - sectionRank(b.section) || a.id.localeCompare(b.id))
}

const sectionRank = (s: ContextSection) => {
  const i = SECTION_ORDER.indexOf(s)
  return i < 0 ? SECTION_ORDER.length : i
}

export function writeCard(slug: string, id: string, card: Omit<ContextCard, 'id' | 'updatedAt'> & { updatedAt?: string }): ContextCard {
  const dir = join(engramDir(slug), 'context')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const updatedAt = card.updatedAt ?? new Date().toISOString()
  const frontmatter = { section: card.section, title: card.title, source: card.source, updatedAt }
  writeFileSync(join(dir, `${id}.md`), matter.stringify(card.body.trim() + '\n', frontmatter))
  return { id, ...card, updatedAt }
}

export function isoDate(value: unknown) {
  const s = String(value ?? '').trim()
  const clickhouse = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d+))?$/.exec(s)
  if (clickhouse) return `${clickhouse[1]}T${clickhouse[2]}.${(clickhouse[3] ?? '').padEnd(3, '0').slice(0, 3)}Z`
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : d.toISOString()
}

export const slugify = (s: string, max = 40) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max) || 'card'

export const timestampId = () => new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
