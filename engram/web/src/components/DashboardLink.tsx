import { useEffect, useState } from 'react'
import { api } from '../lib/api.ts'
import './DashboardLink.css'

const FALLBACK = 'http://127.0.0.1:8765'

export function DashboardLink() {
  const [href, setHref] = useState(FALLBACK)
  useEffect(() => {
    api.config().then((c) => c.dashboard && setHref(c.dashboard)).catch(() => {})
  }, [])
  return (
    <a className="dash-link" href={href} target="_blank" rel="noopener" title="The talking-avatar dashboard: research a person and bring their avatar to life">
      <Grid />
      <span>Dashboard</span>
      <span className="dash-link-arrow" aria-hidden>↗</span>
    </a>
  )
}

function Grid() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </svg>
  )
}
