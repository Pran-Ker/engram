import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { EngramManifest } from '../../../shared/types.ts'
import { api } from '../lib/api.ts'
import { useEngram } from '../lib/useEngram.ts'
import { VideoStage } from '../components/VideoStage.tsx'
import { VoiceBar } from '../components/VoiceBar.tsx'
import { Transcript } from '../components/Transcript.tsx'
import { EngramDrawer } from '../components/EngramDrawer.tsx'
import { ContextBank } from '../components/ContextBank.tsx'
import './EngramPage.css'

const DEFAULT_SLUG = 'prannay'

const statusLabel = { paused: 'Paused', listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking' }

const isTyping = (target: EventTarget | null) => {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

export function EngramPage() {
  const slug = useParams().slug ?? DEFAULT_SLUG
  const navigate = useNavigate()
  const [manifest, setManifest] = useState<EngramManifest | null>(null)
  const [missing, setMissing] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const [bank, setBank] = useState(false)
  const engram = useEngram(slug)

  useEffect(() => {
    setMissing(false)
    api.engram(slug).then(setManifest).catch(() => setMissing(true))
    document.title = 'Engram'
  }, [slug])

  useEffect(() => {
    if (manifest) document.title = `${manifest.name} · Engram`
  }, [manifest])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.code === 'Space' || e.key === ' ') { e.preventDefault(); if (!missing) engram.toggle() }
      else if (e.key === '[') setDrawer((v) => !v)
      else if (e.key === ']') setBank((v) => !v)
      else if (e.key === 'i' || e.key === 'I') navigate(`/inspect/${slug}`)
      else if (e.key === 'Escape') { setDrawer(false); setBank(false) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [engram.toggle, navigate, slug, missing])

  const name = manifest?.name ?? (missing ? 'No engram here' : '')
  const voiceMode = engram.speaking ? 'speaking' : engram.status === 'listening' ? 'listening' : 'off'
  const closePanels = () => { setDrawer(false); setBank(false) }

  return (
    <main className="stage" data-drawer={drawer} data-bank={bank}>
      <header className="stage-top">
        <button className="icon-btn" onClick={() => setDrawer(true)} aria-label="Open list of engrams" title="Engrams  [">
          <Chevron />
        </button>
        <h1 className="stage-name">{name}</h1>
        <button className="icon-btn" onClick={() => setBank(true)} aria-label="Open context bank" title="Context bank  ]">
          <Lines />
        </button>
      </header>

      <section className="stage-center" onClick={() => (drawer || bank) && closePanels()}>
        {missing
          ? <p className="stage-missing">There is no engram called <code>{slug}</code>. Open the list on the left to pick one.</p>
          : <VideoStage slug={slug} speaking={engram.speaking} />}
      </section>

      <footer className="stage-bottom">
        <div className="stage-control">
          <button
            className="start-btn"
            data-running={engram.running}
            onClick={engram.toggle}
            disabled={missing}
            aria-label={engram.running ? 'Pause' : 'Start'}
            title={missing ? 'Pick an engram first' : engram.running ? 'Pause  Space' : 'Start  Space'}
          >
            {engram.running ? <PauseIcon /> : <PlayIcon />}
          </button>
          <span className="stage-status" data-status={engram.status}>{statusLabel[engram.status]}</span>
        </div>
        <div className="stage-voice">
          <VoiceBar mode={voiceMode} playbackNode={engram.playbackNode} micNode={engram.micNode} />
        </div>
        <Transcript
          lines={engram.lines}
          interim={engram.interim}
          blank={missing ? 'Pick an engram on the left to start.' : undefined}
          disabled={missing}
          onSubmit={engram.ask}
        />
      </footer>

      <EngramDrawer open={drawer} current={slug} onClose={() => setDrawer(false)} />
      <ContextBank
        open={bank}
        slug={slug}
        name={manifest?.name ?? 'them'}
        highlighted={engram.usedCards}
        refreshKey={engram.turns}
        onClose={() => setBank(false)}
      />
    </main>
  )
}

function Chevron() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  )
}

function Lines() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M3 4.5h10M3 8h10M3 11.5h10" />
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
      <path d="M6.5 4.4v11.2c0 .6.65.97 1.17.66l9-5.6a.78.78 0 0 0 0-1.32l-9-5.6A.78.78 0 0 0 6.5 4.4Z" />
    </svg>
  )
}

function PauseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
      <rect x="5" y="4" width="3.6" height="12" rx="1" />
      <rect x="11.4" y="4" width="3.6" height="12" rx="1" />
    </svg>
  )
}
