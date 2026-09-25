import { useEffect, useRef } from 'react'
import { level } from '../lib/audio.ts'
import './VoiceBar.css'

type Mode = 'speaking' | 'listening' | 'off'
type Props = {
  mode: Mode
  playbackNode: () => AnalyserNode | null
  micNode: () => AnalyserNode | null
}

const WINDOW_S = 12
const BAR_W = 3
const GAP = 2
const STEP = BAR_W + GAP
const REFLECTION = 0.45
const FLOOR = 0.035

type Sample = { level: number; mode: Mode }

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

export function VoiceBar({ mode, playbackNode, micNode }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const modeRef = useRef(mode)
  const getPlayback = useRef(playbackNode)
  const getMic = useRef(micNode)
  modeRef.current = mode
  getPlayback.current = playbackNode
  getMic.current = micNode

  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    const samples: Sample[] = []
    let width = 0
    let height = 0
    let dpr = 1
    let frame = 0
    let last = performance.now()
    let carry = 0
    let peak = 0

    const colors = {
      accent: cssVar('--accent'),
      accentSoft: cssVar('--accent-soft'),
      dim: cssVar('--fg-2'),
      floor: cssVar('--line-strong'),
      line: cssVar('--line'),
    }

    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1)
      width = canvas.clientWidth
      height = canvas.clientHeight
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    resize()
    for (let i = 0; i < Math.ceil(width / STEP) + 2; i++) samples.push({ level: 0, mode: 'off' })

    const bars = () => Math.ceil(width / STEP) + 1
    const interval = () => (WINDOW_S * 1000) / bars()

    const read = (): Sample => {
      const m = modeRef.current
      const node = m === 'speaking' ? getPlayback.current() : m === 'listening' ? getMic.current() : null
      const raw = level(node)
      peak = Math.max(raw, peak * 0.995)
      const value = m === 'off' ? 0 : raw
      return { level: value, mode: m }
    }

    const draw = (offset: number) => {
      ctx.clearRect(0, 0, width, height)
      const baseline = Math.round(height * 0.62)
      const maxUp = baseline - 6
      const maxDown = (height - baseline) - 4
      ctx.fillStyle = colors.line
      ctx.fillRect(0, baseline, width, 1)

      const count = samples.length
      for (let i = 0; i < count; i++) {
        const s = samples[count - 1 - i]
        const x = width - BAR_W - i * STEP - offset
        if (x + BAR_W < 0) break
        const amp = Math.max(FLOOR, s.level)
        const up = Math.max(1, Math.round(amp * maxUp))
        const down = Math.max(1, Math.round(amp * maxDown * REFLECTION))
        const color = s.level <= FLOOR ? colors.floor : s.mode === 'speaking' ? colors.accent : colors.dim
        ctx.globalAlpha = 1
        ctx.fillStyle = color
        ctx.fillRect(x, baseline - up, BAR_W, up)
        ctx.globalAlpha = s.level <= FLOOR ? 0.35 : 0.3
        ctx.fillRect(x, baseline + 2, BAR_W, down)
      }
      ctx.globalAlpha = 1
    }

    const tick = (now: number) => {
      const dt = now - last
      last = now
      carry += dt
      const step = interval()
      while (carry >= step) {
        carry -= step
        samples.push(read())
        if (samples.length > bars() + 2) samples.shift()
      }
      draw((carry / step) * STEP)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    return () => { cancelAnimationFrame(frame); observer.disconnect() }
  }, [])

  return <canvas ref={canvasRef} className="voicebar" aria-hidden="true" />
}
