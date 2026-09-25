import { b64, submit, poll, download, log } from './bfl.ts'
import { resolve } from 'node:path'

const [src, out, strength = 'moderate'] = process.argv.slice(2)
if (!src || !out) throw new Error('usage: tsx pipelines/video/retone.ts <in.jpg> <out.jpg> [moderate|strong]')
const tone = strength === 'strong'
  ? 'a fair, light wheatish complexion, clearly lighter than now'
  : 'a lighter, fair light-brown wheatish complexion, one to two shades lighter than now'
const prompt = `Change only the skin tone of the man to ${tone}, evenly across face, neck and ears, with clean clear skin and no stubble or blemishes. Keep everything else exactly the same: identical face shape, features, expression, eyes, eyebrows, hair, t-shirt, pose, framing, lighting and the pure black background.`
const t0 = Date.now()
const s = await submit('flux-kontext-pro', { prompt, input_image: b64(src), output_format: 'jpeg', safety_tolerance: 2, seed: 11 })
const r = await poll(s.polling_url)
await download(r.result!.sample!, resolve(out))
log({ ts: new Date().toISOString(), slug: 'prannay', step: `retone:${strength}`, endpoint: 'flux-kontext-pro', id: s.id, prompt, params: { input_image: `<${src}>` }, costCredits: 4, costUsd: 0.04, status: 'ready', out: resolve(out), ms: Date.now() - t0 })
process.stderr.write(`-> ${out} (${Math.round((Date.now() - t0) / 1000)}s)\n`)
