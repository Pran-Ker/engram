import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { ContextCard, ContextSection } from '../../../shared/types.ts'
import { api, ApiError } from '../lib/api.ts'
import './ContextBank.css'

type Props = {
  open: boolean
  slug: string
  name: string
  highlighted: string[]
  refreshKey: number
  onClose: () => void
}

const SECTIONS: Array<{ id: ContextSection; label: string }> = [
  { id: 'live', label: 'Live from the web' },
  { id: 'profile', label: 'Profile' },
  { id: 'story', label: 'Story' },
  { id: 'work', label: 'Work' },
  { id: 'opinions', label: 'Opinions' },
  { id: 'voice', label: 'How he talks' },
  { id: 'memory', label: 'Memories' },
]

const NOTHING_NEW = 'Nothing new on the web for that. The bank already has it.'

const firstName = (name: string) => name.split(' ')[0]

const sentence = (text: string) => {
  const trimmed = text.trim().replace(/[.\s]+$/, '')
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1) + '.'
}

const askFailure = (err: unknown) => {
  if (err instanceof ApiError) return err.status === 404 && /^no engram/.test(err.detail) ? 'Web lookups are not wired up yet.' : sentence(err.detail)
  if (err instanceof Error && err.message.includes('Failed to fetch')) return 'The web lookup did not come back. Is the API running on :4100?'
  return 'The web lookup did not come back. Try a shorter question.'
}

const shortSource = (source: string) => {
  if (!/^https?:\/\//.test(source)) return source
  try {
    const url = new URL(source)
    const segment = url.pathname.split('/').filter(Boolean)[0]
    return url.hostname.replace(/^www\./, '') + (segment ? `/${segment}` : '')
  } catch {
    return source
  }
}

export function ContextBank({ open, slug, name, highlighted, refreshKey, onClose }: Props) {
  const [cards, setCards] = useState<ContextCard[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [query, setQuery] = useState('')
  const [asking, setAsking] = useState(false)
  const [askNote, setAskNote] = useState('')
  const [fresh, setFresh] = useState<string[]>([])

  const load = useCallback(() => {
    api.cards(slug)
      .then((rows) => { setCards(Array.isArray(rows) ? rows : []); setLoadError('') })
      .catch(() => setLoadError('We could not read the context bank. Is the API running on :4100?'))
  }, [slug])

  useEffect(() => { if (open) load() }, [open, load, refreshKey])
  useEffect(() => { setCards(null); setFresh([]) }, [slug])

  const ask = async (e: FormEvent) => {
    e.preventDefault()
    const q = query.trim()
    if (!q || asking) return
    setAsking(true)
    setAskNote('')
    try {
      const added = await api.addWebContext(slug, q)
      if (!Array.isArray(added)) throw new Error('not an array')
      setFresh(added.map((c) => c.id))
      setQuery('')
      if (!added.length) setAskNote(NOTHING_NEW)
      load()
    } catch (err) {
      setAskNote(askFailure(err))
    } finally {
      setAsking(false)
    }
  }

  const bySection = (id: ContextSection) => {
    const rows = (cards ?? []).filter((c) => c.section === id)
    if (id !== 'live') return rows
    return [...rows].sort((a, b) => Number(fresh.includes(b.id)) - Number(fresh.includes(a.id)) || b.updatedAt.localeCompare(a.updatedAt))
  }

  return (
    <aside className="bank" data-open={open} aria-hidden={!open} aria-label="Context bank">
      <header className="bank-head">
        <span className="bank-title">Context bank</span>
        <button className="icon-btn" onClick={onClose} aria-label="Close context bank" title="Close  ]">
          <Lines />
        </button>
      </header>
      <form className="bank-ask" onSubmit={ask} data-busy={asking}>
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setAskNote('') }}
          placeholder={`Ask the web about ${firstName(name)}…`}
          aria-label={`Ask the web about ${name}`}
          autoComplete="off"
          spellCheck={false}
          disabled={asking}
          tabIndex={open ? 0 : -1}
        />
        {asking && <span className="bank-asking">Searching with Nimble</span>}
        {askNote && <span className="bank-aside">{askNote}</span>}
      </form>
      <div className="bank-scroll">
        {loadError && <p className="bank-note">{loadError}</p>}
        {cards?.length === 0 && !loadError && (
          <p className="bank-note">The context bank is empty. Cards come from <code>engrams/{slug}/context/*.md</code>, one file per card, and from the field above.</p>
        )}
        {SECTIONS.map(({ id, label }) => {
          const rows = bySection(id)
          if (!rows.length && id !== 'memory') return null
          return (
            <section key={id} className="bank-section">
              <h3 className="bank-label">{label}</h3>
              {!rows.length && id === 'memory' && <p className="bank-blank">Memories appear here after a conversation.</p>}
              {rows.map((card) => (
                <article key={card.id} className="bank-card" data-used={highlighted.includes(card.id)} data-fresh={fresh.includes(card.id)}>
                  <h4 className="bank-card-title">{card.title}</h4>
                  <Body text={card.body} />
                  <span className="bank-source" title={card.source}>{shortSource(card.source)}</span>
                </article>
              ))}
            </section>
          )
        })}
      </div>
    </aside>
  )
}

function Body({ text }: { text: string }) {
  const blocks = text.replace(/^---[\s\S]*?---\s*/, '').trim().split(/\n\s*\n/)
  return (
    <div className="bank-body">
      {blocks.map((block, i) => {
        const lines = block.split('\n').map((l) => l.trim()).filter(Boolean)
        const isList = lines.every((l) => /^[-*•]\s/.test(l))
        if (isList) return <ul key={i}>{lines.map((l, j) => <li key={j}>{inline(l.replace(/^[-*•]\s+/, ''))}</li>)}</ul>
        return <p key={i}>{inline(lines.join(' '))}</p>
      })}
    </div>
  )
}

const inline = (s: string) =>
  s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part)

function Lines() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M3 4.5h10M3 8h10M3 11.5h10" />
    </svg>
  )
}
