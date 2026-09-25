import type { InspectWord } from '../../../../shared/types.ts'

export function seeded(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hashText(text: string) {
  let h = 2166136261
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return h >>> 0
}

const syllables = (word: string) => Math.max(1, (word.toLowerCase().match(/[aeiouy]+/g) ?? []).length)

export function synthPeaks(words: InspectWord[], durationMs: number, bins: number): Float32Array {
  const rng = seeded(hashText(words.map((w) => w.text).join(' ')))
  const loud = words.map((w) => (0.35 + rng() * 0.6) * (w.text.length < 3 ? 0.7 : 1))
  const skew = words.map(() => 0.25 + rng() * 0.5)
  const phase = words.map(() => rng() * Math.PI)
  const out = new Float32Array(bins)
  const duration = durationMs / 1000
  let smooth = 0
  for (let i = 0; i < bins; i++) {
    const t = ((i + 0.5) / bins) * duration
    let amp = 0.02 + rng() * 0.015
    words.forEach((w, k) => {
      if (t < w.start || t > w.end) return
      const u = (t - w.start) / Math.max(0.01, w.end - w.start)
      const attack = u < skew[k] ? u / skew[k] : (1 - u) / (1 - skew[k])
      const envelope = Math.pow(Math.max(0, attack), 0.45)
      const n = syllables(w.text)
      const pulse = 0.45 + 0.55 * Math.pow(Math.abs(Math.sin(Math.PI * n * u + phase[k])), 0.7)
      const flutter = 0.7 + 0.3 * Math.sin(i * 1.9 + phase[k]) * Math.sin(i * 0.37)
      amp += loud[k] * envelope * pulse * flutter * (0.75 + rng() * 0.5)
    })
    smooth = smooth * 0.35 + amp * 0.65
    out[i] = Math.min(1, smooth)
  }
  return out
}

export function decodePeaks(buffer: AudioBuffer, bins: number): Float32Array {
  const data = buffer.getChannelData(0)
  const per = data.length / bins
  const out = new Float32Array(bins)
  let max = 0
  for (let i = 0; i < bins; i++) {
    const from = Math.floor(i * per)
    const to = Math.min(data.length, Math.floor((i + 1) * per))
    let peak = 0
    for (let j = from; j < to; j++) peak = Math.max(peak, Math.abs(data[j]))
    out[i] = peak
    max = Math.max(max, peak)
  }
  if (max > 0) for (let i = 0; i < bins; i++) out[i] /= max
  return out
}

export function drawWave(canvas: HTMLCanvasElement, peaks: Float32Array, color: string, dim: string) {
  const dpr = window.devicePixelRatio || 1
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  if (!width || !height) return
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr
    canvas.height = height * dpr
  }
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  const mid = height / 2
  ctx.fillStyle = dim
  ctx.fillRect(0, mid - 0.5, width, 1)
  ctx.fillStyle = color
  const barWidth = 2
  const gap = 1
  const columns = Math.floor(width / (barWidth + gap))
  for (let i = 0; i < columns; i++) {
    const idx = Math.floor((i / columns) * peaks.length)
    const h = Math.max(1, peaks[idx] * (height * 0.92))
    ctx.fillRect(i * (barWidth + gap), mid - h / 2, barWidth, h)
  }
}

export const fmtTime = (s: number) => `${s.toFixed(2)}s`

export const fmtClock = (iso: string) => {
  const d = new Date(iso)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
}

export const fmtInt = (n: number) => n.toLocaleString('en-US')
