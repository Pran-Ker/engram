import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const BASE = 'https://api.bfl.ai/v1'
const RUNS = resolve('pipelines/video/runs.jsonl')

export type Run = {
  ts: string
  slug: string
  step: string
  endpoint: string
  id?: string
  prompt: string
  params: Record<string, unknown>
  costCredits?: number
  costUsd?: number
  status: string
  out?: string
  error?: string
  ms?: number
}

export const USD_PER_CREDIT = 0.01
export const VIDEO_USD_PER_S: Record<string, number> = { hd: 0.17, fhd: 0.3, qhd: 0.5, uhd: 0.8 }

function key() {
  const k = process.env.BFL_API_KEY
  if (!k) throw new Error('BFL_API_KEY missing; source ~/.local/secrets')
  return k
}

export function b64(path: string) {
  return readFileSync(path).toString('base64')
}

export function log(run: Run) {
  mkdirSync(dirname(RUNS), { recursive: true })
  appendFileSync(RUNS, JSON.stringify(run) + '\n')
}

type Submit = { id: string; polling_url: string; cost?: number }

export async function submit(endpoint: string, body: Record<string, unknown>): Promise<Submit> {
  const res = await fetch(`${BASE}/${endpoint}`, {
    method: 'POST',
    headers: { 'x-key': key(), 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${endpoint} ${res.status}: ${text.slice(0, 600)}`)
  return JSON.parse(text)
}

type Result = { status: string; result?: { sample?: string; [k: string]: unknown }; progress?: number; details?: unknown; cost?: number }

export async function poll(url: string, timeoutMs = 10 * 60_000, everyMs = 2000): Promise<Result> {
  const start = Date.now()
  let last = ''
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(url, { headers: { 'x-key': key(), accept: 'application/json' } })
    const json = (await res.json()) as Result
    if (json.status !== last) {
      last = json.status
      process.stderr.write(`  ${json.status}${json.progress != null ? ` ${Math.round(json.progress * 100)}%` : ''}\n`)
    }
    if (json.status === 'Ready') return json
    if (json.status === 'Error' || json.status.includes('Moderated') || json.status === 'Task not found') {
      throw new Error(`${json.status}: ${JSON.stringify(json.details ?? json.result ?? {}).slice(0, 600)}`)
    }
    await new Promise((r) => setTimeout(r, everyMs))
  }
  throw new Error(`timeout after ${timeoutMs / 1000}s polling ${url}`)
}

export async function download(url: string, out: string) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download ${res.status} ${url}`)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, Buffer.from(await res.arrayBuffer()))
  return out
}

type GenerateArgs = {
  slug: string
  step: string
  endpoint: string
  body: Record<string, unknown>
  out: string
  costUsd?: number
}

export async function generate(a: GenerateArgs) {
  const started = Date.now()
  const shown = Object.fromEntries(
    Object.entries(a.body).map(([k, v]) => [k, typeof v === 'string' && v.length > 200 ? `<base64 ${v.length}b>` : Array.isArray(v) ? `<${v.length} keyframes>` : v]),
  )
  const run: Run = { ts: new Date().toISOString(), slug: a.slug, step: a.step, endpoint: a.endpoint, prompt: String(a.body.prompt ?? ''), params: shown, status: 'submitted' }
  process.stderr.write(`${a.step}: POST ${a.endpoint}\n`)
  try {
    const s = await submit(a.endpoint, a.body)
    run.id = s.id
    run.costCredits = s.cost
    run.costUsd = s.cost != null ? s.cost * USD_PER_CREDIT : a.costUsd
    const r = await poll(s.polling_url)
    const sample = r.result?.sample
    if (!sample) throw new Error(`no result.sample: ${JSON.stringify(r).slice(0, 400)}`)
    await download(sample, a.out)
    run.status = 'ready'
    run.out = a.out
    run.ms = Date.now() - started
    if (r.cost != null) {
      run.costCredits = r.cost
      run.costUsd = r.cost * USD_PER_CREDIT
    }
    log(run)
    process.stderr.write(`  -> ${a.out} (${(run.ms / 1000).toFixed(0)}s, ~$${(run.costUsd ?? 0).toFixed(2)})\n`)
    return a.out
  } catch (e) {
    run.status = 'error'
    run.error = (e as Error).message
    run.ms = Date.now() - started
    log(run)
    throw e
  }
}
