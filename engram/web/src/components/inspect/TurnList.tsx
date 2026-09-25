import { useEffect, useRef } from 'react'
import type { InspectFlag, InspectTurn } from '../../../../shared/types.ts'
import { fmtClock } from './waveform.ts'

type Props = {
  turns: InspectTurn[]
  selectedId: string | null
  onSelect: (id: string) => void
  flags: InspectFlag[]
  state: 'loading' | 'ready' | 'error'
  error?: string
  onRetry: () => void
  slug: string
}

export function TurnList(p: Props) {
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.is-selected')?.scrollIntoView({ block: 'nearest' })
  }, [p.selectedId])

  const flagCount = (id: string) => p.flags.filter((f) => f.turnId === id).length

  return (
    <aside className="turns">
      <div className="pane-head"><span>Turns</span></div>
      {p.state === 'error' && (
        <p className="state-msg">Couldn't load turns. {p.error} <button className="link" onClick={p.onRetry}>Retry</button></p>
      )}
      {p.state === 'ready' && p.turns.length === 0 && (
        <p className="state-msg">No turns yet. Talk to the engram on the <a href={`/e/${p.slug}`}>stage</a> and they appear here.</p>
      )}
      <ul ref={listRef} className="turn-list" role="listbox" aria-label="Turns">
        {p.turns.map((t) => {
          const n = flagCount(t.id)
          const offVoice = !t.provider.startsWith('modal:') || t.provider === 'modal:base'
          return (
            <li
              key={t.id}
              role="option"
              aria-selected={t.id === p.selectedId}
              className={`turn-row${t.id === p.selectedId ? ' is-selected' : ''}`}
              onClick={() => p.onSelect(t.id)}
            >
              <div className="turn-l1">
                <span className="mono dim">{fmtClock(t.ts)}</span>
                <span className="turn-user">{t.user || '—'}</span>
              </div>
              <div className="turn-l2">
                <span className="turn-text">{t.text}</span>
                <span className="mono dim">{(t.durationMs / 1000).toFixed(1)}s</span>
                <span className={`mono prov${offVoice ? ' is-off' : ''}`} title={t.provider === 'no tts' ? 'no speech synthesized for this turn' : offVoice ? `${t.provider}: not the fine-tuned voice` : 'fine-tuned voice'}>{t.provider === 'no tts' ? '—' : t.provider.replace('modal:', '')}</span>
                {n > 0 && <span className="flag-count mono" title={`${n} flag${n > 1 ? 's' : ''}`}>{n}</span>}
              </div>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}
