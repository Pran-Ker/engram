import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { InspectFaceTag, InspectFlag, InspectFlagTrack, InspectTurn, InspectVoiceTag } from '../../../../shared/types.ts'
import { inspectApi } from './api.ts'
import { decodePeaks, drawWave, fmtClock, fmtTime, synthPeaks } from './waveform.ts'

export const VOICE_TAGS: InspectVoiceTag[] = ['pronunciation', 'pacing', 'timbre', 'artifact']
export const FACE_TAGS: InspectFaceTag[] = ['lip-sync', 'glitch', 'lighting', 'gaze']

type Selection = { start: number; end: number }
type Draft = { track: InspectFlagTrack; tag: string; note: string }
type Audio = { url: string; provider: string; real: boolean }

type Props = {
  slug: string
  turn: InspectTurn | null
  flags: InspectFlag[]
  selectedFlagIds: Set<string>
  onToggleFlag: (id: string) => void
  onAddFlag: (flag: Omit<InspectFlag, 'id' | 'engram' | 'ts'>) => Promise<void>
  posterUrl: string | null
  state: 'loading' | 'ready' | 'error'
  hotkeyTrack: InspectFlagTrack | null
  onHotkeyConsumed: () => void
}

export function TurnDetail(p: Props) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(0)
  const [height, setHeight] = useState(0)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [peaks, setPeaks] = useState<Float32Array | null>(null)
  const [audio, setAudio] = useState<Audio | null>(null)
  const [audioState, setAudioState] = useState<'idle' | 'loading' | 'playing' | 'error'>('idle')
  const [audioError, setAudioError] = useState('')
  const [playhead, setPlayhead] = useState<number | null>(null)
  const [realDuration, setRealDuration] = useState<number | null>(null)
  const [saveError, setSaveError] = useState('')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const drag = useRef<{ x0: number; track: InspectFlagTrack; moved: boolean } | null>(null)

  const turn = p.turn
  const estimated = turn ? turn.durationMs / 1000 : 1
  const duration = realDuration ?? estimated
  const scale = duration / estimated
  const words = useMemo(() => (turn?.words ?? []).map((w) => ({ ...w, start: w.start * scale, end: w.end * scale })), [turn?.id, scale])
  const pxPerSec = width / duration
  const toX = (s: number) => s * pxPerSec
  const toSec = (x: number) => Math.max(0, Math.min(duration, x / pxPerSec))

  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => { setWidth(e.contentRect.width); setHeight(e.contentRect.height) })
    ro.observe(el)
    setWidth(el.clientWidth)
    setHeight(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    setSelection(null)
    setDraft(null)
    setAudio(null)
    setAudioError('')
    setAudioState('idle')
    setPlayhead(null)
    setRealDuration(null)
    audioRef.current?.pause()
    if (!turn) { setPeaks(null); return }
    setPeaks(synthPeaks(turn.words, turn.durationMs, 600))
    if (!turn.wav) return
    let cancelled = false
    loadAudio(turn.wav).then(({ peaks: real, url, seconds, provider }) => {
      if (cancelled) return
      setPeaks(real)
      setRealDuration(seconds)
      setAudio({ url, provider, real: true })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [turn?.id])

  useEffect(() => {
    if (!canvasRef.current || !peaks) return
    const css = getComputedStyle(canvasRef.current)
    drawWave(canvasRef.current, peaks, css.getPropertyValue('--wave').trim() || '#a4a4ab', css.getPropertyValue('--line-strong').trim() || '#34343a')
  }, [peaks, width, height])

  useEffect(() => {
    if (!p.hotkeyTrack || !selection) return
    openDraft(p.hotkeyTrack)
    p.onHotkeyConsumed()
  }, [p.hotkeyTrack])

  const openDraft = (track: InspectFlagTrack) => {
    setSaveError('')
    setDraft({ track, tag: track === 'voice' ? VOICE_TAGS[0] : FACE_TAGS[0], note: '' })
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!turn || e.button !== 0) return
    if ((e.target as HTMLElement).closest('.pop')) return
    const rect = bodyRef.current!.getBoundingClientRect()
    const x0 = e.clientX - rect.left
    const track = ((e.target as HTMLElement).closest('[data-track]') as HTMLElement | null)?.dataset.track === 'face' ? 'face' : 'voice'
    drag.current = { x0, track, moved: false }
    try { bodyRef.current!.setPointerCapture(e.pointerId) } catch {}
    setDraft(null)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    const rect = bodyRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    if (Math.abs(x - drag.current.x0) < 3 && !drag.current.moved) return
    drag.current.moved = true
    const a = toSec(drag.current.x0)
    const b = toSec(x)
    setSelection({ start: Math.min(a, b), end: Math.max(a, b) })
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    try { bodyRef.current?.releasePointerCapture(e.pointerId) } catch {}
    if (!d.moved) {
      const band = (e.target as HTMLElement).closest('[data-flag]') as HTMLElement | null
      if (band) {
        const f = p.flags.find((x) => x.id === band.dataset.flag)
        if (f) { setSelection({ start: f.start, end: f.end }); p.onToggleFlag(f.id) }
        return
      }
      if (audioRef.current && audio) seek(toSec(d.x0))
      else setSelection(null)
      return
    }
    openDraft(d.track)
  }

  const saveDraft = async () => {
    if (!turn || !selection || !draft) return
    const flag = { turnId: turn.id, track: draft.track, start: round3(selection.start), end: round3(selection.end), tag: draft.tag as InspectFlag['tag'], note: draft.note.trim() }
    setDraft(null)
    setSelection(null)
    try {
      await p.onAddFlag(flag)
    } catch (err) {
      setSaveError(`Flag not saved: ${(err as Error).message}`)
      setSelection({ start: flag.start, end: flag.end })
      setDraft(draft)
    }
  }

  const seek = (s: number) => {
    if (!audioRef.current) return
    audioRef.current.currentTime = s
    setPlayhead(s)
  }

  const togglePlay = useCallback(async () => {
    if (!turn) return
    if (audioRef.current && audio) {
      if (audioRef.current.paused) { await audioRef.current.play().catch(() => {}); setAudioState('playing') }
      else { audioRef.current.pause(); setAudioState('idle') }
      return
    }
    setAudioState('loading')
    setAudioError('')
    try {
      const { audio: buf, provider } = await inspectApi.synthesize(p.slug, turn.text, turn.id)
      const decoded = await decode(buf.slice(0))
      const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }))
      setPeaks(decodePeaks(decoded, 600))
      setRealDuration(decoded.duration)
      setAudio({ url, provider, real: true })
      setAudioState('playing')
      requestAnimationFrame(() => audioRef.current?.play().catch(() => setAudioState('idle')))
    } catch (err) {
      setAudioState('error')
      setAudioError(`No audio for this turn: ${(err as Error).message}. Voice endpoint is not up.`)
    }
  }, [turn?.id, audio, p.slug])

  useEffect(() => {
    if (audioState !== 'playing') return
    let raf = 0
    const tick = () => {
      const a = audioRef.current
      if (a && !a.paused) { setPlayhead(a.currentTime); raf = requestAnimationFrame(tick) }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [audioState])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.code === 'Space' && turn) { e.preventDefault(); void togglePlay() }
      if (e.key === 'Escape') { setDraft(null); setSelection(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay, turn])

  const ticks = useMemo(() => tickMarks(duration), [duration])
  const frames = useMemo(() => Math.max(6, Math.floor(width / 96)), [width])
  const narrowFrames = width / frames < 96
  const videoFrames = useVideoFrames(p.slug, turn?.id, frames, duration, p.posterUrl !== null)
  const voiceFlags = p.flags.filter((f) => f.track === 'voice')
  const faceFlags = p.flags.filter((f) => f.track === 'face')

  if (p.state === 'ready' && !turn) {
    return (
      <section className="detail">
        <div className="pane-head"><span>Turn</span></div>
        <p className="state-msg">No turn selected. Pick one on the left, or talk to the engram on the stage and it appears here.</p>
      </section>
    )
  }

  return (
    <section className="detail">
      <div className="pane-head">
        <span>Turn</span>
        {turn && <span className="mono dim" title={turn.id}>{turn.id.length > 14 ? turn.id.slice(0, 8) : turn.id}</span>}
        <span className="ih-spacer" />
        {turn && (
          <>
            <span className="mono dim">first token {turn.latencyMs} ms</span>
            <span className="mono dim">{turn.provider}</span>
            <span className="mono dim">{turn.source === 'rawtree' ? 'rawtree' : 'fixture'}</span>
          </>
        )}
      </div>

      {turn && (
        <div className="detail-text">
          <p className="q">{turn.user}</p>
          <p className="a">{turn.text}</p>
        </div>
      )}

      <div className="tl-tools">
        <button className="btn btn-sm" onClick={() => void togglePlay()} disabled={!turn || audioState === 'loading'}>
          {audioState === 'playing' ? '❚❚ Pause' : audio ? '▶ Play' : audioState === 'loading' ? 'Synthesizing…' : '▶ Synthesize'}<kbd>space</kbd>
        </button>
        <span className="mono dim">{turn ? fmtTime(duration) : ''}{realDuration === null && turn ? ' est.' : ''}</span>
        <span className="mono dim tl-src">{audio ? `waveform · ${audio.provider}` : 'waveform · synthetic from text'}</span>
        {selection && <span className="mono sel-label">{fmtTime(selection.start)} → {fmtTime(selection.end)} <span className="dim">· v voice · f face · esc</span></span>}
        {audioError && <span className="err tl-err" title={audioError}>{audioError}</span>}
        <span className="ih-spacer" />
        {turn && <span className="mono dim">{fmtClock(turn.ts)}</span>}
      </div>

      <div className="tl" ref={bodyRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        <div className="tl-ruler" data-track="voice">
          {ticks.map((t) => (
            <span key={t} className="tick" style={{ left: toX(t) }}><i /><em className="mono">{t.toFixed(t % 1 === 0 ? 0 : 1)}s</em></span>
          ))}
        </div>
        <div className="tl-wave" data-track="voice">
          <canvas ref={canvasRef} />
          {voiceFlags.map((f) => <Band key={f.id} flag={f} toX={toX} selected={p.selectedFlagIds.has(f.id)} />)}
          {draft && selection && (
            <FlagPopover
              draft={draft}
              selection={selection}
              left={Math.max(0, Math.min(width - 360, toX(selection.start)))}
              onChange={setDraft}
              onSave={saveDraft}
              onCancel={() => { setDraft(null); setSelection(null) }}
              error={saveError}
            />
          )}
        </div>
        <div className="tl-words" data-track="voice">
          {words.map((w, i) => (
            <span key={i} className="word" style={{ left: toX(w.start), width: Math.max(4, toX(w.end) - toX(w.start)) }} title={`${w.text} ${fmtTime(w.start)}–${fmtTime(w.end)}`}>{w.text}</span>
          ))}
        </div>
        <div className={`tl-frames${narrowFrames ? ' is-narrow' : ''}`} data-track="face">
          {Array.from({ length: frames }, (_, i) => (
            <div
              key={i}
              className={`frame${p.posterUrl ? '' : ' is-dark'}`}
              style={{ width: `${100 / frames}%`, backgroundImage: frameUrl(videoFrames?.[i] ?? p.posterUrl) }}
            >
              <span className="mono">{fmtTime((i / frames) * duration)}</span>
            </div>
          ))}
          {!p.posterUrl && <span className="frames-empty">Frames appear when engrams/{p.slug}/video/poster.jpg exists · npm run video:build {p.slug}</span>}
          {faceFlags.map((f) => <Band key={f.id} flag={f} toX={toX} selected={p.selectedFlagIds.has(f.id)} />)}
        </div>

        {selection && <div className="tl-sel" style={{ left: toX(selection.start), width: Math.max(1, toX(selection.end) - toX(selection.start)) }} />}
        {playhead !== null && audio && <div className="tl-playhead" style={{ left: toX(Math.min(duration, playhead)) }} />}
      </div>

      <FlagTable flags={p.flags} selected={p.selectedFlagIds} onToggle={p.onToggleFlag} onFocus={(f) => setSelection({ start: f.start, end: f.end })} />

      {audio && <audio ref={audioRef} src={audio.url} onEnded={() => { setAudioState('idle'); setPlayhead(null) }} onPause={() => setAudioState('idle')} />}
    </section>
  )
}

function Band(p: { flag: InspectFlag; toX: (s: number) => number; selected: boolean }) {
  const left = p.toX(p.flag.start)
  const w = Math.max(2, p.toX(p.flag.end) - left)
  return (
    <div className={`band${p.selected ? ' is-selected' : ''}`} data-flag={p.flag.id} style={{ left, width: w }} title={`${p.flag.tag}${p.flag.note ? ` · ${p.flag.note}` : ''} (click to select for distill)`}>
      <span className="mono">{p.flag.tag}</span>
    </div>
  )
}

function FlagPopover(p: { draft: Draft; selection: Selection; left: number; onChange: (d: Draft) => void; onSave: () => void; onCancel: () => void; error: string }) {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus({ preventScroll: true }) }, [])
  const tags = p.draft.track === 'voice' ? VOICE_TAGS : FACE_TAGS
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); p.onSave() }
    if (e.key === 'Escape') { e.preventDefault(); p.onCancel() }
    const n = Number(e.key)
    if (e.metaKey || e.ctrlKey || !(n >= 1 && n <= tags.length) || (e.target as HTMLInputElement).value) return
    e.preventDefault()
    p.onChange({ ...p.draft, tag: tags[n - 1] })
  }
  return (
    <div className="pop flag-pop" style={{ left: p.left }} onKeyDown={onKey} onPointerDown={(e) => e.stopPropagation()}>
      <div className="seg" role="radiogroup" aria-label="Track">
        {(['voice', 'face'] as InspectFlagTrack[]).map((t) => (
          <button key={t} role="radio" aria-checked={p.draft.track === t} className={p.draft.track === t ? 'is-on' : ''} onClick={() => p.onChange({ track: t, tag: t === 'voice' ? VOICE_TAGS[0] : FACE_TAGS[0], note: p.draft.note })}>{t}</button>
        ))}
        <span className="mono dim">{fmtTime(p.selection.start)} → {fmtTime(p.selection.end)}</span>
      </div>
      <div className="chips">
        {tags.map((t, i) => (
          <button key={t} className={`chip${p.draft.tag === t ? ' is-on' : ''}`} onClick={() => p.onChange({ ...p.draft, tag: t })}><kbd>{i + 1}</kbd>{t}</button>
        ))}
      </div>
      <input ref={inputRef} className="note" value={p.draft.note} placeholder="what's wrong here (optional)" onChange={(e) => p.onChange({ ...p.draft, note: e.target.value })} />
      <div className="pop-actions">
        {p.error ? <span className="err">{p.error}</span> : <span className="dim">enter to flag · esc to cancel</span>}
        <span className="ih-spacer" />
        <button className="btn btn-sm" onClick={p.onCancel}>Cancel</button>
        <button className="btn btn-sm btn-accent" onClick={p.onSave}>Flag {p.draft.tag}</button>
      </div>
    </div>
  )
}

function FlagTable(p: { flags: InspectFlag[]; selected: Set<string>; onToggle: (id: string) => void; onFocus: (f: InspectFlag) => void }) {
  if (!p.flags.length) {
    return <p className="state-msg flags-empty">No flags on this turn. Drag across the waveform (voice) or the frames (face) to mark a region.</p>
  }
  return (
    <table className="flags">
      <tbody>
        {[...p.flags].sort((a, b) => a.start - b.start).map((f) => (
          <tr key={f.id} className={p.selected.has(f.id) ? 'is-selected' : ''} onClick={() => p.onFocus(f)}>
            <td className="chk"><input type="checkbox" checked={p.selected.has(f.id)} onChange={() => p.onToggle(f.id)} onClick={(e) => e.stopPropagation()} aria-label="Select for distill" /></td>
            <td className="mono dim">{f.track}</td>
            <td className="mono tag">{f.tag}</td>
            <td className="mono">{fmtTime(f.start)} → {fmtTime(f.end)}</td>
            <td className="note-cell">{f.note || <span className="dim">—</span>}</td>
            <td className="mono dim">{fmtClock(f.ts)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function tickMarks(duration: number) {
  const step = duration > 12 ? 2 : duration > 6 ? 1 : 0.5
  const out: number[] = []
  for (let t = 0; t <= duration; t += step) out.push(round3(t))
  return out
}

async function loadAudio(url: string) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${r.status}`)
  const buf = await r.arrayBuffer()
  const decoded = await decode(buf.slice(0))
  const source = url.includes('/wav/cache/') ? 'tts-cache' : 'review/voice'
  const provider = r.headers.get('x-voice-provider')
  return { peaks: decodePeaks(decoded, 600), url: URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })), seconds: decoded.duration, provider: provider ? `${source} · ${provider}` : source }
}

let ctx: AudioContext | null = null
async function decode(buf: ArrayBuffer) {
  ctx ??= new AudioContext()
  return ctx.decodeAudioData(buf)
}

const frameUrl = (src: string | null) => (src ? `url(${src})` : undefined)

const frameCache = new Map<string, string[]>()

function useVideoFrames(slug: string, turnId: string | undefined, count: number, duration: number, enabled: boolean) {
  const [frames, setFrames] = useState<string[] | null>(null)
  const key = `${slug}:${turnId}:${count}:${duration.toFixed(1)}`
  useEffect(() => {
    if (!enabled || !turnId || !count) { setFrames(null); return }
    const hit = frameCache.get(key)
    setFrames(hit ?? null)
    if (hit) return
    let cancelled = false
    const times = Array.from({ length: count }, (_, i) => (i / count) * duration)
    sampleVideoFrames(`/api/engrams/${slug}/video/talk`, times)
      .then((urls) => { frameCache.set(key, urls); if (!cancelled) setFrames(urls) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [key, enabled])
  return frames
}

async function sampleVideoFrames(src: string, times: number[]) {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.src = src
  await new Promise<void>((resolve, reject) => {
    video.onloadeddata = () => resolve()
    video.onerror = () => reject(new Error('video unavailable'))
  })

  const canvas = document.createElement('canvas')
  canvas.width = 192
  canvas.height = 108
  const g = canvas.getContext('2d')!
  const loop = video.duration || 1
  const out: string[] = []
  for (const t of times) {
    await seekVideo(video, t % loop)
    g.drawImage(video, 0, 0, canvas.width, canvas.height)
    out.push(canvas.toDataURL('image/jpeg', 0.72))
  }

  video.removeAttribute('src')
  video.load()
  return out
}

const seekVideo = (video: HTMLVideoElement, t: number) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, 1500)
  video.onseeked = () => { clearTimeout(timer); resolve() }
  video.currentTime = t
})

const round3 = (n: number) => Math.round(n * 1000) / 1000
