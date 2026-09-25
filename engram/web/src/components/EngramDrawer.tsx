import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { EngramSummary } from '../../../shared/types.ts'
import { api } from '../lib/api.ts'
import './EngramDrawer.css'

type Props = { open: boolean; current: string; onClose: () => void }

const DOCS_URL = '/api/docs/adding-an-engram.md'

export function EngramDrawer({ open, current, onClose }: Props) {
  const navigate = useNavigate()
  const [list, setList] = useState<EngramSummary[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    api.engrams()
      .then((rows) => { setList(Array.isArray(rows) ? rows : []); setError('') })
      .catch(() => setError('We could not load the list of engrams. Is the API running on :4100?'))
  }, [open])

  const choose = (slug: string) => { onClose(); if (slug !== current) navigate(`/e/${slug}`) }

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
        {list?.map((e) => (
          <button key={e.slug} className="drawer-row" data-current={e.slug === current} onClick={() => choose(e.slug)} tabIndex={open ? 0 : -1}>
            <span className="drawer-name">{e.name}</span>
            <span className="drawer-tagline">{e.tagline}</span>
            <span className="drawer-marks">
              <Mark ok={e.ready.voice} label="voice" />
              <Mark ok={e.ready.video} label="face" />
              <Mark ok={e.ready.context} label="context" />
            </span>
          </button>
        ))}
        <div className="drawer-add">
          <span className="drawer-name">Add an engram</span>
          <span className="drawer-tagline">
            A folder in <code>engrams/&lt;slug&gt;/</code> with a few photos, a few minutes of voice, and notes in <code>context/</code>. Restart the server and it appears here.
          </span>
          <a className="drawer-link" href={DOCS_URL} target="_blank" rel="noreferrer" tabIndex={open ? 0 : -1}>Steps in docs</a>
        </div>
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
