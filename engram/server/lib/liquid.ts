import type { PromptMessage } from './prompt.ts'

export const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434'
export const DEFAULT_MODEL = process.env.LIQUID_MODEL ?? 'hf.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF:Q4_K_M'
const KEEP_ALIVE = '2h'

export async function* streamChat(
  model: string,
  messages: PromptMessage[],
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const body = {
    model,
    messages,
    stream: true,
    keep_alive: KEEP_ALIVE,
    options: { temperature: 0.3, top_p: 0.9, repeat_penalty: 1.0, num_predict: 80, num_ctx: 4096 },
  }
  const r = await fetch(`${OLLAMA_URL}/api/chat`, { method: 'POST', body: JSON.stringify(body), signal })
  if (!r.ok || !r.body) throw new Error(`ollama ${r.status}: ${await r.text()}`)

  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      const chunk = JSON.parse(line) as { message?: { content?: string }; done?: boolean; error?: string }
      if (chunk.error) throw new Error(chunk.error)
      if (chunk.message?.content) yield chunk.message.content
      if (chunk.done) return
    }
  }
}

export async function listModels(): Promise<string[]> {
  const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) })
  if (!r.ok) throw new Error(`ollama ${r.status}`)
  const j = (await r.json()) as { models?: { name: string }[] }
  return (j.models ?? []).map((m) => m.name)
}

export function warmModel(model: string) {
  fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    body: JSON.stringify({ model, messages: [], keep_alive: KEEP_ALIVE }),
    signal: AbortSignal.timeout(20000),
  }).catch(() => {})
}
