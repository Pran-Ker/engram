import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import type { InspectCheckpoint, InspectRun } from '../../../../shared/types.ts'
import { fmtInt } from './waveform.ts'

type Props = {
  name: string
  slug: string
  run: InspectRun | null
  loadedStep: number | null
  onLoad: (step: number) => void
  popoverOpen: boolean
  setPopoverOpen: (open: boolean) => void
  selectedFlags: number
  onDistill: () => void
}

export function Header(p: Props) {
  const popRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!p.popoverOpen) return
    const close = (e: PointerEvent) => {
      if (!popRef.current?.contains(e.target as Node)) p.setPopoverOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [p.popoverOpen, p.setPopoverOpen])

  const step = p.loadedStep ?? p.run?.currentStep ?? null

  return (
    <header className="ih">
      <Link to={`/e/${p.slug}`} className="ih-back" title="Back to the stage">‹ stage</Link>
      <span className="ih-name">{p.name}</span>
      <span className="ih-sep">·</span>
      <span className="mono">{p.run?.id ?? '—'}</span>
      <span className="ih-spacer" />
      <div className="ih-pop-anchor" ref={popRef}>
        <button className={`btn${p.popoverOpen ? ' is-open' : ''}`} onClick={() => p.setPopoverOpen(!p.popoverOpen)} aria-haspopup="menu" aria-expanded={p.popoverOpen} title="Loaded checkpoint · click to change">
          Checkpoint {step !== null && <span className="mono">{fmtInt(step)}</span>}<span className="chev">▾</span><kbd>L</kbd>
        </button>
        {p.popoverOpen && p.run && (
          <CheckpointPopover checkpoints={p.run.checkpoints} loaded={p.loadedStep} onLoad={(s) => { p.onLoad(s); p.setPopoverOpen(false) }} />
        )}
      </div>
      <button className="btn btn-accent" disabled={p.selectedFlags === 0} onClick={p.onDistill} title={p.selectedFlags ? `Queue a distill run from checkpoint ${fmtInt(step ?? 0)}` : 'Select at least one flag'}>
        Distill <span className="chev">▸</span>{p.selectedFlags > 0 && <span className="count">{p.selectedFlags}</span>}<kbd>D</kbd>
      </button>
    </header>
  )
}

function CheckpointPopover(p: { checkpoints: InspectCheckpoint[]; loaded: number | null; onLoad: (step: number) => void }) {
  const bestVal = Math.min(...p.checkpoints.map((c) => c.valLoss))
  return (
    <div className="pop" role="menu">
      <table className="ckpt">
        <thead>
          <tr><th>step</th><th>ep</th><th>train</th><th>val</th><th>sim</th><th>wer</th><th /></tr>
        </thead>
        <tbody>
          {p.checkpoints.map((c) => {
            const isLoaded = c.step === p.loaded
            return (
              <tr key={c.step} className={isLoaded ? 'is-loaded' : ''}>
                <td className="mono">{fmtInt(c.step)}</td>
                <td className="mono dim">{c.epoch}</td>
                <td className="mono">{c.trainLoss.toFixed(3)}</td>
                <td className={`mono${c.valLoss === bestVal ? ' best' : ''}`}>{c.valLoss.toFixed(3)}</td>
                <td className="mono">{c.speakerSim.toFixed(2)}</td>
                <td className="mono">{c.wer.toFixed(1)}%</td>
                <td>
                  {isLoaded
                    ? <span className="loaded-tag">loaded</span>
                    : <button className="btn btn-sm" onClick={() => p.onLoad(c.step)}>Load</button>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="pop-foot dim">val is on 240 held-out clips · sim is ECAPA cosine · lowest val marked</div>
    </div>
  )
}
