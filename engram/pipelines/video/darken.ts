import { b64, submit, poll, download, log } from './bfl.ts'
import { resolve } from 'node:path'

const [src, out] = process.argv.slice(2)
if (!src || !out) throw new Error('usage: tsx pipelines/video/darken.ts <in.jpg> <out.jpg>')
const prompt = 'Replace the grey studio backdrop with a seamless pure black background (#0b0b0c) that receives no light, no gradient, no halo. Keep the person exactly as is: same face, hair, expression, skin, t-shirt, pose, framing and lighting on the face.'
const t0 = Date.now()
const s = await submit('flux-kontext-pro', { prompt, input_image: b64(src), output_format: 'jpeg', safety_tolerance: 2, seed: 7 })
const r = await poll(s.polling_url)
await download(r.result!.sample!, resolve(out))
log({ ts: new Date().toISOString(), slug: 'prannay', step: 'darken', endpoint: 'flux-kontext-pro', id: s.id, prompt, params: { input_image: `<${src}>` }, costCredits: 4, costUsd: 0.04, status: 'ready', out: resolve(out), ms: Date.now() - t0 })
process.stderr.write(`-> ${out} (${Math.round((Date.now() - t0) / 1000)}s)\n`)
