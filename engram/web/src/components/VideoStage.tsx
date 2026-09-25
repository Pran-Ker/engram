import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.ts'
import './VideoStage.css'

type Props = { slug: string; speaking: boolean }
type ClipState = 'loading' | 'ready' | 'missing'

export function VideoStage({ slug, speaking }: Props) {
  const idleRef = useRef<HTMLVideoElement>(null)
  const talkRef = useRef<HTMLVideoElement>(null)
  const [idle, setIdle] = useState<ClipState>('loading')
  const [talk, setTalk] = useState<ClipState>('loading')
  const [poster, setPoster] = useState<ClipState>('loading')

  const ready = idle === 'ready' && talk === 'ready'
  const missing = idle === 'missing' || talk === 'missing'

  useEffect(() => {
    setIdle('loading'); setTalk('loading'); setPoster('loading')
  }, [slug])

  useEffect(() => {
    if (!ready) return
    idleRef.current?.play().catch(() => {})
    talkRef.current?.play().catch(() => {})
  }, [ready])

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
      onError={() => set('missing')}
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
      {missing && (
        <p className="stage-note">
          Face not generated yet. Run <code>npm run video:build {slug}</code>.
        </p>
      )}
    </div>
  )
}
