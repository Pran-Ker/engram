import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { EngramManifest } from '../../../shared/types.ts'
import { api } from '../lib/api.ts'
import { useEngram, type Line } from '../lib/useEngram.ts'
import { EngramDrawer } from '../components/EngramDrawer.tsx'
import { ContextBank } from '../components/ContextBank.tsx'
import { TalkFace, type FaceMode } from '../components/TalkFace.tsx'
import { DashboardLink } from '../components/DashboardLink.tsx'
import './TalkPage.css'

const DEFAULT_SLUG = 'prannay'
const POLL_MS = 3000
const RENDER_TIMEOUT_MS = 6 * 60 * 1000
const SUGGESTIONS = ['Who are you?', 'What are you working on right now?', 'What did you do before this?']

type ReplyJob = { job?: string; status?: string; url?: string; seconds?: number; estimate_usd?: number; cached?: boolean; error?: string }
type Reply = { status: 'rendering' | 'done' | 'failed'; note: string; url?: string }
type Health = { ok: boolean; detail?: string }

const isTyping = (target: EventTarget | null) => {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const firstName = (name: string) => name.split(' ')[0]
const money = (usd?: number) => (usd === undefined ? '' : `$${usd.toFixed(2)}`)

export function TalkPage() {
  const slug = useParams().slug ?? DEFAULT_SLUG
  const navigate = useNavigate()
  const [manifest, setManifest] = useState<EngramManifest | null>(null)
  const [missing, setMissing] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const [bank, setBank] = useState(false)
  const [draft, setDraft] = useState('')
  const [videoReplies, setVideoReplies] = useState(true)
  const [replyHealth, setReplyHealth] = useState<Health | null>(null)
  const [replies, setReplies] = useState<Record<string, Reply>>({})
  const [face, setFace] = useState<FaceMode>('idle')
  const [replySrc, setReplySrc] = useState<string | null>(null)
  const [introPlayed, setIntroPlayed] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const playbackDone = useRef<(() => void) | null>(null)

  const canVideo = !!replyHealth?.ok
  const useVideo = canVideo && videoReplies

  const renderReply = useCallback(async (lineId: string, text: string) => {
    const set = (r: Reply) => setReplies((all) => ({ ...all, [lineId]: r }))
    set({ status: 'rendering', note: 'Rendering the spoken reply with FLUX 3…' })
    const started = Date.now()
    try {
      const first = await fetch(`/api/engrams/${slug}/reply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
      let job = (await first.json()) as ReplyJob
      if (!first.ok) throw new Error(job.error || `render failed (${first.status})`)
      while (job.status === 'rendering') {
        const secs = Math.round((Date.now() - started) / 1000)
        set({ status: 'rendering', note: `Rendering the spoken reply with FLUX 3 · ${job.seconds ?? '?'} s clip · ${secs}s` })
        await wait(POLL_MS)
        if (Date.now() - started > RENDER_TIMEOUT_MS) throw new Error('render timed out')
        const r = await fetch(`/api/engrams/${slug}/reply?job=${encodeURIComponent(job.job ?? '')}`).catch(() => null)
        if (r?.ok) job = (await r.json()) as ReplyJob
      }
      if (job.status !== 'done' || !job.url) throw new Error(job.error || 'render failed')
      set({ status: 'done', note: `Spoken by FLUX 3 · ${job.seconds ?? '?'} s · ${job.cached ? 'cached' : money(job.estimate_usd)}`, url: job.url })
      await play(job.url)
    } catch (e) {
      set({ status: 'failed', note: `Video reply unavailable: ${(e as Error).message}. Shown as text.` })
    }
  }, [slug])

  const play = (url: string) => new Promise<void>((resolve) => {
    playbackDone.current?.()
    playbackDone.current = () => { playbackDone.current = null; setFace('idle'); resolve() }
    setReplySrc(url)
    setFace('reply')
  })

  const engram = useEngram(slug, {
    voice: !useVideo,
    onAnswer: useVideo ? renderReply : undefined,
  })

  useEffect(() => {
    setMissing(false); setManifest(null); setReplies({}); setIntroPlayed(false); setFace('idle'); setReplySrc(null); setReplyHealth(null)
    api.engram(slug).then(setManifest).catch(() => setMissing(true))
    fetch(`/api/engrams/${slug}/reply/health`).then((r) => r.json()).then(setReplyHealth).catch(() => setReplyHealth({ ok: false, detail: 'unreachable' }))
  }, [slug])

  useEffect(() => {
    document.title = manifest ? `${manifest.name} · Talk · Engram` : 'Talk · Engram'
  }, [manifest])

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [engram.lines, engram.interim, replies])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.code === 'Space' || e.key === ' ') { e.preventDefault(); if (!missing) engram.toggle() }
      else if (e.key === '/') { e.preventDefault(); inputRef.current?.focus() }
      else if (e.key === '[') setDrawer((v) => !v)
      else if (e.key === ']') setBank((v) => !v)
      else if (e.key === 'i' || e.key === 'I') navigate(`/inspect/${slug}`)
      else if (e.key === 's' || e.key === 'S') navigate(`/e/${slug}`)
      else if (e.key === 'Escape') { setDrawer(false); setBank(false) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [engram.toggle, navigate, slug, missing])

  const ask = (text: string) => {
    const t = text.trim()
    if (!t || missing) return
    if (face === 'intro') { setFace('idle'); setIntroPlayed(true) }
    if (face === 'reply') playbackDone.current?.()
    setDraft('')
    void engram.ask(t)
  }
  const submit = (e: FormEvent) => { e.preventDefault(); ask(draft) }

  const onFaceEnded = useCallback((mode: FaceMode) => {
    if (mode === 'intro') { setFace('idle'); setIntroPlayed(true) }
    if (mode === 'reply') playbackDone.current?.()
  }, [])
  const onFaceError = useCallback((mode: FaceMode) => {
    if (mode === 'intro') { setFace('idle'); setIntroPlayed(true) }
    if (mode === 'reply') playbackDone.current?.()
  }, [])

  const name = manifest?.name ?? (missing ? 'No engram here' : '')
  const rendering = Object.values(replies).some((r) => r.status === 'rendering')
  const status = face === 'intro' || face === 'reply' ? 'speaking' : rendering ? 'rendering' : engram.status
  const statusLabel = { paused: 'Paused', listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking', rendering: 'Rendering' }[status]
  const speaking = engram.speaking || face === 'intro' || face === 'reply'
  const intro = manifest?.intro
  const blank = engram.lines.length === 0 && !engram.interim

  return (
    <main className="talk" data-drawer={drawer} data-bank={bank}>
      <header className="talk-top">
        <button className="icon-btn" onClick={() => setDrawer(true)} aria-label="Open list of engrams" title="Engrams  [">
          <Chevron />
        </button>
        <div className="talk-title">
          <h1 className="talk-name">{name}</h1>
          {manifest?.tagline && <span className="talk-tagline">{manifest.tagline}</span>}
        </div>
        <div className="talk-actions">
          <DashboardLink />
          {!missing && <Link to={`/e/${slug}`} className="talk-link" title="Full-screen stage  S"><Screen />Stage</Link>}
          <button className="icon-btn" onClick={() => setBank(true)} aria-label="Open context bank" title="Context bank  ]">
            <Lines />
          </button>
        </div>
      </header>

      <section className="talk-body" onClick={() => (drawer || bank) && (setDrawer(false), setBank(false))}>
        <aside className="face-card">
          {missing
            ? <div className="face face-blank" />
            : <TalkFace
                slug={slug}
                mode={face}
                speaking={speaking}
                rendering={rendering}
                hasIntro={!!intro?.video}
                introPlayed={introPlayed}
                replySrc={replySrc}
                onPlayIntro={() => { engram.pause(); setFace('intro') }}
                onEnded={onFaceEnded}
                onError={onFaceError}
              />}
          <div className="face-meta">
            <span className="talk-status" data-status={status}><i />{statusLabel}</span>
            {canVideo && (
              <label className="talk-check" title="FLUX 3 renders the avatar saying each answer with its own voice. Takes one to two minutes per reply.">
                <input type="checkbox" checked={videoReplies} onChange={(e) => setVideoReplies(e.target.checked)} />
                Spoken video replies
              </label>
            )}
            {engram.micState !== 'off' && engram.micState !== 'on' && <span className="talk-mic-note">Microphone unavailable. Type below.</span>}
          </div>
        </aside>

        <section className="thread" aria-label="Conversation">
          <div className="thread-lines" ref={listRef}>
            {missing && <p className="thread-blank">There is no engram called <code>{slug}</code>. Open the list on the left to pick one.</p>}
            {intro?.text && !missing && (
              <div className="bubble" data-role="engram">{intro.text}</div>
            )}
            {blank && !missing && (
              <div className="thread-start">
                <p className="thread-blank">Ask {firstName(manifest?.name ?? 'them')} anything. Answers come from the context bank on the right{useVideo ? ', spoken by a rendered clip of the face' : ''}.</p>
                <div className="thread-chips">
                  {SUGGESTIONS.map((s) => <button key={s} className="thread-chip" onClick={() => ask(s)}>{s}</button>)}
                </div>
              </div>
            )}
            {engram.lines.map((line) => <Bubble key={line.id} line={line} reply={replies[line.id]} onReplay={(url) => void play(url)} />)}
            {engram.interim && <div className="bubble" data-role="interim">{engram.interim}</div>}
          </div>
          <form className="thread-input" onSubmit={submit}>
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={missing ? 'Pick an engram first' : `Ask ${firstName(manifest?.name ?? 'them')} something`}
              aria-label="Your question"
              autoComplete="off"
              spellCheck={false}
              disabled={missing}
            />
            <button
              type="button"
              className="mic-btn"
              data-on={engram.running}
              onClick={engram.toggle}
              disabled={missing}
              aria-label={engram.running ? 'Stop listening' : 'Listen'}
              title={engram.running ? 'Stop listening  Space' : 'Listen  Space'}
            >
              <Mic />
            </button>
            <button type="submit" className="send-btn" disabled={missing || !draft.trim()}>Send</button>
          </form>
        </section>
      </section>

      <EngramDrawer open={drawer} current={slug} surface="talk" onClose={() => setDrawer(false)} />
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

function Bubble({ line, reply, onReplay }: { line: Line; reply?: Reply; onReplay: (url: string) => void }) {
  if (line.role === 'user') return <div className="bubble" data-role="user">{line.text}</div>
  if (line.role === 'note') return <div className="bubble" data-role="note">{line.text}</div>
  if (!line.sentences.length && !line.draft && !line.error) return <div className="bubble" data-role="engram"><span className="bubble-draft">…</span></div>
  return (
    <div className="bubble" data-role="engram">
      {line.sentences.map((s) => <span key={s.index} className="bubble-s" data-status={s.status}>{s.text} </span>)}
      {line.draft && <span className="bubble-draft">{line.draft}</span>}
      {line.error && <span className="bubble-aside">{line.error}</span>}
      {reply && (reply.url
        ? <button className="bubble-aside bubble-replay" onClick={() => onReplay(reply.url!)} title="Play the clip again">{reply.note} · replay</button>
        : <span className="bubble-aside" data-status={reply.status}>{reply.note}</span>)}
    </div>
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
function Screen() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="12" height="8" rx="1.5" />
      <path d="M6 13.5h4" />
    </svg>
  )
}
function Mic() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" />
      <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" />
    </svg>
  )
}
