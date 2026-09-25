// Direct mode writer: a research record about a person (for example one row of a lead-enrichment CSV)
// becomes a complete engram folder. Nothing here is specific to one person.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EngramManifest } from '../../../shared/types.ts'
import { engramDir } from '../engram-store.ts'
import { slugify, writeCard } from '../cards.ts'
import { DIRECT_MODEL } from './openrouter.ts'
import { buildLoops, type Loops } from './video.ts'

/** Accepted keys. The right-hand aliases are the column names of the longhorizonhack people.csv. */
const ALIASES: Record<string, string[]> = {
  slug: ['slug', 'person_id'],
  name: ['name', 'full_name'],
  headline: ['headline', 'title'],
  company: ['company', 'current_company'],
  location: ['location'],
  bio: ['bio', 'bio_summary'],
  education: ['education'],
  past_companies: ['past_companies'],
  recent_signals: ['recent_signals'],
  pronouns: ['pronouns'],
  company_url: ['company_url'],
  company_description: ['company_description'],
  company_tagline: ['company_tagline'],
  company_products: ['company_products'],
  company_customers: ['company_customers'],
  company_founded_year: ['company_founded_year'],
  company_founders: ['company_founders'],
  company_competitors: ['company_competitors'],
  company_funding_stage: ['company_funding_stage'],
  company_hq_location: ['company_hq_location'],
  company_recent_news: ['company_recent_news'],
  speech: ['speech', 'avatar_speech'],
  pitch: ['pitch', 'pitch_script'],
  sources: ['sources', 'source_urls'],
}
type Person = Record<keyof typeof ALIASES, string> & { posts: Post[] }
export type Post = { url: string; snippet?: string; platform?: string; posted_at?: string }
export type DirectResult = { slug: string; name: string; cards: number; video: Loops | null; photo: boolean }

const MAX_POSTS = 12
const OWNED_PREFIXES = ['profile-01-who', 'work-01-role', 'work-02-company', 'work-03-recent', 'story-01-career', 'voice-01-in-my-words', 'live-post-']

export function normalize(input: Record<string, unknown>): Person {
  const pick = (keys: string[]) => {
    for (const k of keys) {
      const v = input[k]
      if (Array.isArray(v)) return v.join(' ')
      if (v !== undefined && v !== null && String(v).trim()) return String(v).trim()
    }
    return ''
  }
  const p = Object.fromEntries(Object.entries(ALIASES).map(([field, keys]) => [field, pick(keys)])) as Person
  p.posts = Array.isArray(input.posts) ? (input.posts as Post[]).filter((x) => x && typeof x.url === 'string').slice(0, MAX_POSTS) : []
  return p
}

export function writeDirectEngram(input: Record<string, unknown>, assets: { photo?: { bytes: Buffer; ext: string }; clip?: Buffer }): DirectResult {
  const p = normalize(input)
  if (!p.name) throw new Error('name (or full_name) is required')
  const slug = slugify(p.slug || p.name, 60)
  const dir = engramDir(slug)
  for (const sub of ['context', 'photos', 'video']) mkdirSync(join(dir, sub), { recursive: true })
  clearOwnedCards(dir)

  const manifest: EngramManifest = {
    slug,
    name: p.name,
    tagline: [p.headline, p.company].filter(Boolean).join(' · ') || 'Direct avatar engram',
    ...(p.pronouns ? { pronouns: p.pronouns } : {}),
    mode: 'direct',
    voice: { provider: 'modal', run: 'base', systemPrompt: 'Perform TTS. Use the base voice.' },
    video: { idle: 'video/idle.mp4', talk: 'video/talk.mp4', poster: 'video/poster.jpg' },
    brain: { provider: 'openrouter', model: DIRECT_MODEL, persona: persona(p) },
  }
  writeFileSync(join(dir, 'engram.json'), JSON.stringify(manifest, null, 2) + '\n')

  const source = p.sources.split(/\s+/)[0] || 'direct engram: research record'
  const companySource = p.company_url || source
  const me = (text: string) => asFirstPerson(text, p.name, p.pronouns)
  let cards = 0
  const card = (id: string, section: 'profile' | 'story' | 'work' | 'voice' | 'live', title: string, body: string, src = source) => {
    if (!body.trim()) return
    writeCard(slug, id, { section, title, body: body.trim(), source: src })
    cards++
  }

  card('profile-01-who', 'profile', 'Who I am', [me(p.bio), p.location && `I'm based in ${p.location}.`, p.education && `Education: ${p.education}.`].filter(Boolean).join('\n\n'))
  card('work-01-role', 'work', p.company ? `What I do at ${p.company}` : 'What I do',
    [p.headline && p.company ? `I'm ${p.headline} at ${p.company}.` : p.headline ? `I'm ${p.headline}.` : '', p.company_description].filter(Boolean).join('\n\n'), companySource)
  card('work-02-company', 'work', p.company ? `About ${p.company}` : 'About my company', bullets([
    ['Tagline', p.company_tagline], ['Founded', p.company_founded_year], ['Headquarters', p.company_hq_location], ['Funding', p.company_funding_stage],
    ['Products', p.company_products], ['Customers', p.company_customers], ['Founders', p.company_founders], ['Competitors', p.company_competitors],
  ]), companySource)
  card('work-03-recent', 'work', 'Recently', [p.company_recent_news, me(p.recent_signals)].filter(Boolean).join('\n\n'), companySource)
  card('story-01-career', 'story', 'Where I worked before', p.past_companies && `Before ${p.company || 'this'}, I worked at ${p.past_companies}.`)
  card('voice-01-in-my-words', 'voice', 'In my own words', [
    p.speech && `Q: Who are you and what do you do? A: ${oneLine(p.speech)}`,
    p.pitch && p.pitch !== p.speech && `Q: Tell me about your company. A: ${oneLine(p.pitch)}`,
  ].filter(Boolean).join('\n'))
  p.posts.forEach((post, i) => {
    const when = post.posted_at ? ` (${post.posted_at})` : ''
    card(`live-post-${String(i + 1).padStart(2, '0')}-${slugify(post.snippet ?? post.url, 30)}`, 'live', `${post.platform || 'web'} post${when}`, post.snippet || post.url, post.url)
  })

  let video: Loops | null = null
  let photoWritten = false
  if (assets.photo) {
    const photo = join(dir, 'photos', `01${assets.photo.ext}`)
    writeFileSync(photo, assets.photo.bytes)
    photoWritten = true
    let clipPath: string | undefined
    if (assets.clip) { clipPath = join(dir, 'video', 'source-clip.mp4'); writeFileSync(clipPath, assets.clip) }
    video = buildLoops(dir, photo, clipPath)
    if (clipPath) rmSync(clipPath, { force: true })
  }
  return { slug, name: p.name, cards, video, photo: photoWritten }
}

/** Direct mode owns these ids and rewrites them on every call; memory-* and hand-written cards are left alone. */
function clearOwnedCards(dir: string) {
  const ctx = join(dir, 'context')
  if (!existsSync(ctx)) return
  for (const f of readdirSync(ctx)) if (OWNED_PREFIXES.some((p) => f.startsWith(p))) rmSync(join(ctx, f), { force: true })
}

function persona(p: Person) {
  const role = [p.headline, p.company && `at ${p.company}`].filter(Boolean).join(' ')
  return `You are ${p.name}${role ? `, ${role}` : ''}, speaking out loud to someone standing in front of you. Answer in first person, in one to three short spoken sentences. Warm, direct, specific, no corporate voice, no lists, no markdown. Your notes were gathered from your public profiles and your company's site; treat them as your own memory. Stick to what they say, and if they do not cover something, say so plainly and move on.`
}

const bullets = (rows: [string, string][]) => rows.filter(([, v]) => v).map(([k, v]) => `- ${k}: ${v}`).join('\n')
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** Third-person research prose → first person, driven by the person's own name (and pronouns when given). */
export function asFirstPerson(text: string, name: string, pronouns = '') {
  if (!text) return ''
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const first = name.split(/\s+/)[0]
  let out = text
  for (const n of [name, first].filter(Boolean)) {
    out = out.replace(new RegExp(`\\b${esc(n)}'s\\b`, 'g'), 'my').replace(new RegExp(`\\b${esc(n)}\\b`, 'g'), 'I')
  }
  const subject = /she/i.test(pronouns) ? ['She', 'she'] : /he/i.test(pronouns) ? ['He', 'he'] : null
  if (subject) {
    out = out.replace(new RegExp(`\\b${subject[0]}\\b`, 'g'), 'I').replace(new RegExp(`\\b${subject[1]}\\b`, 'g'), 'I')
    out = subject[1] === 'she' ? out.replace(/\bHer\b/g, 'My').replace(/\bher\b/g, 'my') : out.replace(/\bHis\b/g, 'My').replace(/\bhis\b/g, 'my').replace(/\bhim\b/g, 'me')
  }
  return out
    .replace(/\bI is\b/g, 'I am').replace(/\bI was\b/g, 'I was').replace(/\bI has\b/g, 'I have').replace(/\bI does\b/g, 'I do')
    .replace(/\bI (work|live|lead|run|build|focus|help|serve|hold|own|manage|write|speak|teach|advise|partner|join|head|drive|cover|spend|call|treat|keep|tell|read|listen|say|think|take|want|play|like|come|go|sit|cut|get|make|see|know|believe|argue|consider|describe|prefer|reach|use)(?:s|es)\b/g, 'I $1')
}
