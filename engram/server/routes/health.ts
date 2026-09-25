import { Hono } from 'hono'
import { listModels, DEFAULT_MODEL } from '../lib/liquid.ts'
import { lastStatus as nimbleStatus } from '../lib/nimble.ts'
import { ping as rawtreePing } from '../lib/rawtree.ts'
import { loadManifest } from '../lib/engram-store.ts'
import type { Health } from '../../shared/types.ts'

export const health = new Hono()

const PORT = Number(process.env.PORT ?? 4100)

health.get('/', async (c) => {
  const [ollama, tts, nimble, rawtree, bfl] = await Promise.all([checkOllama(), checkTts(), checkNimble(), rawtreePing(), checkBfl()])
  const result: Health = { ollama, tts, nimble, rawtree, bfl }
  return c.json(result)
})

async function checkOllama(): Promise<Health['ollama']> {
  const wanted = manifestModel()
  try {
    const models = await listModels()
    const ok = models.includes(wanted)
    return { ok, model: wanted, detail: ok ? `${models.length} model(s) loaded` : `pull it: ollama pull ${wanted}` }
  } catch (e) {
    return { ok: false, model: wanted, detail: `Ollama not reachable: ${(e as Error).message}` }
  }
}

function manifestModel() {
  try { return loadManifest('prannay').brain.model || DEFAULT_MODEL } catch { return DEFAULT_MODEL }
}

async function checkTts(): Promise<Health['tts']> {
  const keyed = !!process.env.MODAL_TOKEN_ID
  try {
    const r = await fetch(`http://localhost:${PORT}/api/engrams/prannay/tts/health`, { signal: AbortSignal.timeout(4000) })
    if (r.ok) {
      const j = (await r.json()) as { ok?: boolean; provider?: string; detail?: string; stub?: string; run?: string; loaded?: string[]; base_model?: string }
      if (j.stub === undefined && typeof j.ok === 'boolean') {
        const detail = j.detail ?? [j.base_model, j.run && `run ${j.run}`, j.loaded?.length && `loaded: ${j.loaded.join(', ')}`].filter(Boolean).join(' · ')
        return { ok: j.ok, provider: j.provider, detail }
      }
    }
  } catch {}
  return { ok: keyed, provider: keyed ? 'modal' : undefined, detail: keyed ? 'MODAL_TOKEN_ID present; tts route has no health endpoint yet' : 'MODAL_TOKEN_ID missing' }
}

async function checkNimble(): Promise<Health['nimble']> {
  return { ok: nimbleStatus.ok, detail: nimbleStatus.at ? `${nimbleStatus.detail} (last call ${nimbleStatus.at})` : nimbleStatus.detail }
}

async function checkBfl(): Promise<Health['bfl']> {
  const key = process.env.BFL_API_KEY
  if (!key) return { ok: false, detail: 'BFL_API_KEY missing' }
  try {
    const r = await fetch('https://api.bfl.ai/v1/credits', { headers: { 'x-key': key }, signal: AbortSignal.timeout(4000) })
    if (!r.ok) return { ok: r.status !== 401 && r.status !== 403, detail: `credits endpoint HTTP ${r.status}` }
    const j = (await r.json()) as { credits?: number }
    return { ok: true, detail: `${Math.round(j.credits ?? 0)} credits` }
  } catch (e) {
    return { ok: true, detail: `key present; credits check failed: ${(e as Error).message}` }
  }
}
