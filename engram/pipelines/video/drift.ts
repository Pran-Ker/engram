import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const SCRIPT = resolve('pipelines/video/drift.py')

export type DriftSample = { n: number; s: number; cx: number; cy: number; score: number }

export type Drift = {
  fps: number
  frames: number
  face: number[]
  samples: DriftSample[]
  fit: { s: number[]; cx: number[]; cy: number[] }
  maxScale: number
  minScale: number
}

export type ScaleRow = { clip: string; t: number; face: number; eyesDy: number; torso: number }

function run(args: string[]) {
  return JSON.parse(execFileSync('uv', ['run', SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }))
}

export function measureDrift(path: string): Drift {
  return run(['measure', path])
}

export function trend(d: Drift) {
  const [a, b, c] = d.fit.s
  const at = (n: number) => a + b * n + c * n * n
  return { start: Number(at(0).toFixed(3)), end: Number(at(d.frames - 1).toFixed(3)), max: d.maxScale }
}

export function scaleCheck(out: string, clips: string[], times = [0, 3, 6]): ScaleRow[] {
  return run(['compare', out, times.join(','), ...clips])
}
