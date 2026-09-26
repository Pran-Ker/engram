import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.ts'
import './TalkFace.css'

export type FaceMode = 'idle' | 'intro' | 'reply'
type Props = {
  slug: string
  mode: FaceMode
  speaking: boolean
  rendering: boolean
  hasIntro: boolean
  introPlayed: boolean
  replySrc: string | null
  onPlayIntro: () => void
  onEnded: (mode: FaceMode) => void
  onError: (mode: FaceMode) => void
}

// Square crop of the stage loops: direct-mode loops are the photo letterboxed onto the page colour, so `cover`
// shows exactly the photo; a 16:9 studio portrait keeps its centre.
export function TalkFace({ slug, mode, speaking, rendering, hasIntro, introPlayed, replySrc, onPlayIntro, onEnded, onError }: Props) {
  const idleRef = useRef<HTMLVideoElement>(null)
  const talkRef = useRef<HTMLVideoElement>(null)
  const introRef = useRef<HTMLVideoElement>(null)
  const replyRef = useRef<HTMLVideoElement>(null)
  const [loops, setLoops] = useState(false)
  const [poster, setPoster] = useState(true)

  useEffect(() => { setLoops(false); setPoster(true) }, [slug])

  useEffect(() => {
    if (!loops) return
    idleRef.current?.play().catch(() => {})
    talkRef.current?.play().catch(() => {})
  }, [loops])

  useEffect(() => {
    const v = introRef.current
    if (!v) return
    if (mode === 'intro') { v.currentTime = 0; v.play().catch(() => onError('intro')) }
    else { v.pause() }
  }, [mode, onError])

  useEffect(() => {
    const v = replyRef.current
    if (!v) return
    if (mode === 'reply' && replySrc) { v.currentTime = 0; v.play().catch(() => onError('reply')) }
    else { v.pause() }
  }, [mode, replySrc, onError])

  const showLoops = mode === 'idle'
  return (
    <div className="face" data-mode={mode} data-rendering={rendering}>
      {poster && <img className="face-layer" src={api.videoUrl(slug, 'poster')} alt="" onError={() => setPoster(false)} />}
      <video ref={idleRef} className="face-layer" data-visible={showLoops && !speaking && loops} src={api.videoUrl(slug, 'idle')} muted loop playsInline preload="auto" onCanPlayThrough={() => setLoops(true)} />
      <video ref={talkRef} className="face-layer" data-visible={showLoops && speaking && loops} src={api.videoUrl(slug, 'talk')} muted loop playsInline preload="auto" />
      {hasIntro && (
        <video ref={introRef} className="face-layer" data-visible={mode === 'intro'} src={api.videoUrl(slug, 'intro')} playsInline preload="auto" onEnded={() => onEnded('intro')} onError={() => onError('intro')} />
      )}
      <video ref={replyRef} className="face-layer" data-visible={mode === 'reply'} src={replySrc ?? undefined} playsInline preload="auto" onEnded={() => onEnded('reply')} onError={() => onError('reply')} />
      {rendering && <span className="face-ring" aria-label="Rendering the spoken reply" />}
      {hasIntro && !introPlayed && mode === 'idle' && (
        <button className="face-play" onClick={onPlayIntro}>
          <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor"><path d="M6.5 4.4v11.2c0 .6.65.97 1.17.66l9-5.6a.78.78 0 0 0 0-1.32l-9-5.6A.78.78 0 0 0 6.5 4.4Z" /></svg>
          Play intro
        </button>
      )}
    </div>
  )
}
