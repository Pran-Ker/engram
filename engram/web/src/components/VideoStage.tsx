import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.ts'
import './VideoStage.css'

type Props = { slug: string; speaking: boolean; onMissing: (missing: boolean) => void }
type ClipState = 'loading' | 'ready' | 'missing'

const RETRIES = 2
const RETRY_MS = 1500

export function VideoStage({ slug, speaking, onMissing }: Props) {
  const idleRef = useRef<HTMLVideoElement>(null)
  const talkRef = useRef<HTMLVideoElement>(null)
  const [idle, setIdle] = useState<ClipState>('loading')
  const [talk, setTalk] = useState<ClipState>('loading')
  const [poster, setPoster] = useState<ClipState>('loading')
  const retries = useRef({ idle: 0, talk: 0 })

  const ready = idle === 'ready' && talk === 'ready'
  const missing = idle === 'missing' || talk === 'missing'

  useEffect(() => {
    setIdle('loading'); setTalk('loading'); setPoster('loading')
    retries.current = { idle: 0, talk: 0 }
  }, [slug])

  useEffect(() => {
    if (!ready) return
    idleRef.current?.play().catch(() => {})
    talkRef.current?.play().catch(() => {})
  }, [ready])

  useEffect(() => { onMissing(missing) }, [missing, onMissing])

  const clip = (ref: typeof idleRef, set: (s: ClipState) => void, name: 'idle' | 'talk') => (
    <video
      key={`${slug}-${name}`}
      ref={ref}
      className="stage-video"
      data-visible={ready && (name === 'talk') === speaking}
      src={api.videoUrl(slug, name)}
      muted
      loop
      playsInline
      preload="auto"
      onCanPlayThrough={() => set('ready')}
      onError={(e) => {
        const video = e.currentTarget
        if (retries.current[name]++ < RETRIES) setTimeout(() => video.load(), RETRY_MS)
        else set('missing')
      }}
    />
  )

  return (
    <div className="stage-display" data-ready={ready}>
      <div className="stage-presence" data-visible={!ready} data-speaking={speaking} />
      <div className="stage-frame">
        {poster !== 'missing' && (
          <img
            key={`${slug}-poster`}
            className="stage-poster"
            data-visible={!ready && poster === 'ready'}
            src={api.videoUrl(slug, 'poster')}
            alt=""
            onLoad={() => setPoster('ready')}
            onError={() => setPoster('missing')}
          />
        )}
        {clip(idleRef, setIdle, 'idle')}
        {clip(talkRef, setTalk, 'talk')}
      </div>
    </div>
  )
}
