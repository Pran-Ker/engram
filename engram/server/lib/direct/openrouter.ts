// Direct mode brain: Liquid LFM2.5 served by OpenRouter, so a direct engram needs no local Ollama.
// Same generator shape as lib/liquid.ts streamChat so routes/chat.ts can pick either.
import type { PromptMessage } from '../prompt.ts'

export const OPENROUTER_URL = process.env.OPENROUTER_URL ?? 'https://openrouter.ai/api/v1'
export const DIRECT_MODEL = process.env.DIRECT_MODEL ?? 'liquid/lfm-2.5-2.6b:free'
// The free Liquid endpoint always reasons before it answers and that reasoning counts against max_tokens,
// so the budget is well above the 80 tokens the Ollama path uses. Reasoning deltas are dropped below.
const MAX_TOKENS = Number(process.env.DIRECT_MAX_TOKENS ?? 600)
const RATE_LIMIT_WAIT_MS = 2500  // the free tier answers 429 under bursts; one short wait usually clears it

export type DirectStatus = { ok: boolean; at?: string; detail: string }
export let lastStatus: DirectStatus = {
  ok: !!process.env.OPENROUTER_API_KEY,
  detail: process.env.OPENROUTER_API_KEY ? 'key present, no call yet' : 'OPENROUTER_API_KEY missing',
}

export async function* streamChat(model: string, messages: PromptMessage[], signal?: AbortSignal, maxTokens = MAX_TOKENS): AsyncGenerator<string> {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new Error('OPENROUTER_API_KEY missing: direct engrams answer through OpenRouter')
  const started = Date.now()
  const request = () => fetch(`${OPENROUTER_URL}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/Pran-Ker/engram',
      'X-Title': 'Engram direct mode',
    },
    body: JSON.stringify({ model, messages, stream: true, max_tokens: maxTokens, temperature: 0.3 }),  // no top_p: Liquid's provider rejects it
  })
  let r = await request()
  if (r.status === 429 && !signal?.aborted) { await new Promise((res) => setTimeout(res, RATE_LIMIT_WAIT_MS)); r = await request() }
  if (!r.ok || !r.body) {
    const detail = `openrouter ${r.status}: ${(await r.text()).slice(0, 200)}`
    lastStatus = { ok: false, at: new Date().toISOString(), detail }
    throw new Error(detail)
  }

  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let chars = 0
  const finish = () => { lastStatus = { ok: true, at: new Date().toISOString(), detail: `${chars} chars in ${Date.now() - started} ms via ${model} (${maxTokens} tokens)` } }
  read: for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') break read
      let chunk: { error?: { message?: string }; choices?: { delta?: { content?: string | null } }[] }
      try { chunk = JSON.parse(data) } catch { continue }
      if (chunk.error) throw new Error(chunk.error.message ?? 'openrouter error')
      const text = chunk.choices?.[0]?.delta?.content
      if (text) {
        if (!chars) lastStatus = { ok: true, at: new Date().toISOString(), detail: `first token after ${Date.now() - started} ms via ${model}` }
        chars += text.length
        yield text
      }
    }
  }
  finish()
  // The model sometimes spends the whole budget reasoning and emits no answer. Nothing was streamed yet, so retry once, bigger.
  if (!chars && maxTokens === MAX_TOKENS && !signal?.aborted) yield* streamChat(model, messages, signal, MAX_TOKENS * 3)
}
