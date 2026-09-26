import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { EngramSummary } from '../../../shared/types.ts'
import { api } from '../lib/api.ts'
import './EngramDrawer.css'

export type Surface = 'stage' | 'talk'
type Props = { open: boolean; current: string; surface: Surface; onClose: () => void }

const PATH: Record<Surface, string> = { stage: '/e', talk: '/talk' }
const LABEL: Record<Surface, string> = { stage: 'Stage', talk: 'Talk' }
const HINT: Record<Surface, string> = { stage: 'Open on the stage: full-screen face, voice in and out.', talk: 'Open the talk page: typed chat, spoken video replies.' }

export function EngramDrawer({ open, current, surface, onClose }: Props) {
  const navigate = useNavigate()
  const [list, setList] = useState<EngramSummary[] | null>(null)
  const [error, setError] = useState('')
  const other: Surface = surface === 'stage' ? 'talk' : 'stage'

  useEffect(() => {
    if (!open) return
    api.engrams()
      .then((rows) => { setList(Array.isArray(rows) ? rows : []); setError('') })
      .catch(() => setError('We could not load the list of engrams. Is the API running on :4100?'))
  }, [open])

  const choose = (slug: string, to: Surface) => {
    onClose()
    if (slug !== current || to !== surface) navigate(`${PATH[to]}/${slug}`)
  }

  return (
    <aside className="drawer" data-open={open} aria-hidden={!open} aria-label="Engrams">
      <header className="drawer-head">
        <button className="icon-btn" onClick={onClose} aria-label="Close list" title="Close  [">
          <Chevron />
        </button>
        <span className="drawer-title">Engrams</span>
      </header>
      <div className="drawer-list">
        {error && <p className="drawer-error">{error}</p>}
        {list?.length === 0 && !error && (
          <p className="drawer-error">No engrams yet. Add a folder under <code>engrams/&lt;slug&gt;/</code>, or send a person from the dashboard with <b>Talk to me</b>.</p>
        )}
        {list?.map((e) => (
          <div key={e.slug} className="drawer-row" data-current={e.slug === current}>
            <button className="drawer-main" onClick={() => choose(e.slug, surface)} tabIndex={open ? 0 : -1} title={HINT[surface]}>
              <span className="drawer-name">{e.name}</span>
              <span className="drawer-tagline">{e.tagline}</span>
              <span className="drawer-marks">
                <Mark ok={e.ready.voice} label="voice" />
                <Mark ok={e.ready.video} label="face" />
                <Mark ok={e.ready.context} label="context" />
              </span>
            </button>
            <button className="drawer-switch" onClick={() => choose(e.slug, other)} tabIndex={open ? 0 : -1} title={HINT[other]} aria-label={`${LABEL[other]}: ${e.name}`}>
              {other === 'talk' ? <Bubble /> : <Screen />}
              <span>{LABEL[other]}</span>
            </button>
          </div>
        ))}
      </div>
    </aside>
  )
}

function Mark({ ok, label }: { ok: boolean; label: string }) {
  return <span className="drawer-mark" data-ok={ok}><i />{label}</span>
}

function Chevron() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  )
}

function Bubble() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
    </svg>
  )
}

function Screen() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="12" height="8" rx="1.5" />
      <path d="M6 13.5h4" />
    </svg>
  )
}
