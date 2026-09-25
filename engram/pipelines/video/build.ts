import { existsSync, readdirSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { b64, generate, VIDEO_USD_PER_S } from './bfl.ts'
import { probe, pingPong, crossfadeLoop, stillToIdle, frame, poster, psnr } from './ffmpeg.ts'
import { measureDrift, scaleCheck, trend } from './drift.ts'

const args = process.argv.slice(2)
const slug = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? 'prannay'
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const has = (name: string) => args.includes(`--${name}`)

const step = flag('step', 'all')
const candidates = Number(flag('candidates', '3'))
const from = Number(flag('from', '1'))
const seconds = Number(flag('seconds', '6'))
const resolution = flag('resolution', 'fhd')
const size = resolution === 'hd' ? '1280x720' : '1920x1080'
const loopMode = flag('loop', 'pingpong')
const black = Number(flag('black', '20'))
const grey = Number(flag('grey', '14'))

const dir = resolve('engrams', slug)
const photos = join(dir, 'photos')
const video = join(dir, 'video')
const review = resolve('review/video')
const work = resolve('pipelines/video/work', slug)
for (const d of [video, review, work]) mkdirSync(d, { recursive: true })

const IDENTITY = 'the same young man as in the reference images, matching the FIRST reference most closely: identical face, fair wheatish complexion, noticeably light skin with an even clean tone (lighter than the dim indoor lighting of the reference photos suggests), thick dark curly hair with volume on top, strong dark eyebrows, clean-shaven with clear smooth skin, same nose, eyes and jawline'

const PORTRAIT_PROMPT = [
  `Photorealistic studio portrait of ${IDENTITY}.`,
  'Chest-up, perfectly centered, the head occupies the middle of the frame with generous headroom so the whole hairstyle is visible well below the top edge, facing the camera, eyes looking straight into the lens, calm relaxed attentive expression, mouth closed, natural resting face.',
  'Plain dark charcoal crew-neck t-shirt.',
  'Bright soft even studio key light on the face, flattering fill so no side of the face falls into shadow, subtle hair light. The backdrop receives no light at all: a seamless near-black studio background, almost pure black (#0b0b0c), no gradient, no spotlight halo, no banding.',
  'Shot on an 85mm lens at f/2.8, clean natural skin texture without stubble or blemishes, sharp eyes, cinematic but neutral color grade.',
  'No text, no watermark, no hands, no props, nothing else in frame.',
].join(' ')

const IDLE_PROMPT = 'The man stays still and listens attentively. Subtle natural idle motion only: gentle breathing, one or two slow blinks, tiny head movements, calm attentive expression, eyes on the camera. Static camera, no zoom, no pan, no hands, no lighting change, background stays a plain dark studio. Seamless, understated, photoreal.'

const TALK_PROMPT = 'Locked-off tripod shot, fixed focal length: no zoom, no dolly, no push-in, no pan, no drift, no camera movement of any kind. The subject stays exactly the same size and position in frame from the first frame to the last frame; his head stays centered and his shoulders stay on the same line. The man is mid-conversation, visibly talking to the camera the entire time: his lips clearly open and close on every word, jaw moving, animated expressive speech with natural pauses, slight nods, eyebrows rising as he makes a point, warm confident energy. No hands entering the frame, no lighting change, background stays a plain dark studio. Photoreal.'

function refs() {
  return readdirSync(photos).filter((f) => /\.jpe?g$/i.test(f) && !f.startsWith('08')).sort().map((f) => join(photos, f))
}

async function portrait() {
  const [r1, r2, r3, r4] = refs()
  const outs: string[] = []
  for (let i = from; i < from + candidates; i++) {
    const out = join(review, `portrait-${i}.jpg`)
    const body = {
      prompt: PORTRAIT_PROMPT,
      input_image: b64(r1),
      input_image_2: b64(r2),
      input_image_3: b64(r3),
      input_image_4: b64(r4),
      width: 1920,
      height: 1088,
      safety_tolerance: 2,
      output_format: 'jpeg',
      seed: 1000 + i,
    }
    try {
      await generate({ slug, step: 'portrait', endpoint: 'flux-2-pro', body, out })
    } catch (e) {
      process.stderr.write(`  flux-2-pro failed: ${(e as Error).message}\n  falling back to flux-kontext-pro\n`)
      await generate({
        slug,
        step: 'portrait',
        endpoint: 'flux-kontext-pro',
        body: { prompt: PORTRAIT_PROMPT, input_image: b64(r1), input_image_2: b64(r2), aspect_ratio: '16:9', safety_tolerance: 2, output_format: 'jpeg', seed: 1000 + i },
        out,
      })
    }
    outs.push(out)
  }
  return outs
}

async function clip(kind: 'idle' | 'talk', src: string, tag: string) {
  const out = join(work, `${tag}-${kind}.mp4`)
  const body = {
    mode: 'i2v',
    prompt: kind === 'idle' ? IDLE_PROMPT : TALK_PROMPT,
    keyframes: [b64(src)],
    duration: seconds,
    resolution,
    aspect_ratio: '16:9',
    generate_audio: false,
    safety_tolerance: 2,
  }
  await generate({ slug, step: `${kind}:${tag}`, endpoint: 'flux-3-video', body, out, costUsd: (VIDEO_USD_PER_S[resolution] ?? 0.3) * seconds })
  copyFileSync(out, join(review, `${tag}-${kind}-raw.mp4`))
  return out
}

function loops(idleRaw: string | null, talkRaw: string | null, still: string) {
  const idle = join(video, 'idle.mp4')
  const talk = join(video, 'talk.mp4')
  const make = (src: string, out: string) => (loopMode === 'xfade' ? crossfadeLoop(src, out, size, black, grey) : pingPong(src, out, size, black, grey))
  if (idleRaw) make(idleRaw, idle)
  else stillToIdle(still, idle, size, black, grey)
  if (talkRaw) make(talkRaw, talk)
  else copyFileSync(idle, talk)
  poster(idle, join(video, 'poster.jpg'))
  for (const f of ['idle.mp4', 'talk.mp4', 'poster.jpg']) copyFileSync(join(video, f), join(review, f))
  return verify(idle, talk, [idleRaw, talkRaw])
}

function verify(idle: string, talk: string, raws: (string | null)[]) {
  const a = probe(idle)
  const b = probe(talk)
  const report: Record<string, unknown> = { idle: a, talk: b, sizeMatch: a.width === b.width && a.height === b.height }
  report.scaleCheck = scaleCheck(join(review, 'scale-check.jpg'), [idle, talk])
  report.rawDrift = Object.fromEntries(raws.filter((r): r is string => !!r).map((r) => [basename(r), trend(measureDrift(r))]))
  for (const [name, p] of [['idle', idle], ['talk', talk]] as const) {
    const first = join(work, `${name}-first.jpg`)
    const last = join(work, `${name}-last.jpg`)
    frame(p, first, 'first')
    frame(p, last, 'last')
    report[`${name}LoopPsnr`] = psnr(first, last)
    copyFileSync(first, join(review, `${name}-first.jpg`))
    copyFileSync(last, join(review, `${name}-last.jpg`))
  }
  writeFileSync(join(review, 'verify.json'), JSON.stringify(report, null, 2))
  process.stderr.write(JSON.stringify(report, null, 2) + '\n')
  return report
}

async function main() {
  let chosen = flag('portrait', join(review, 'portrait-chosen.jpg'))
  if (step === 'portrait' || step === 'all') {
    const outs = await portrait()
    process.stderr.write(`portraits: ${outs.map((o) => basename(o)).join(', ')}\nlook at them, then: npm run video:build -- ${slug} --step clips --portrait review/video/portrait-N.jpg\n`)
    if (step === 'portrait') return
    chosen = outs[0]
  }
  if (!existsSync(chosen)) throw new Error(`no portrait at ${chosen}; pass --portrait review/video/portrait-N.jpg`)
  const tag = basename(chosen).replace(/\.\w+$/, '')
  const idleRaw = join(work, `${tag}-idle.mp4`)
  const talkRaw = join(work, `${tag}-talk.mp4`)
  const fail = (kind: string) => (e: Error) => process.stderr.write(`  ${kind} i2v failed: ${e.message}\n`)
  if (step === 'clips' || step === 'idle' || step === 'all') await clip('idle', chosen, tag).catch(fail('idle'))
  if (step === 'clips' || step === 'talk' || step === 'all') await clip('talk', chosen, tag).catch(fail('talk'))
  if (has('no-loops')) return
  copyFileSync(chosen, join(review, 'portrait-chosen.jpg'))
  loops(existsSync(idleRaw) ? idleRaw : null, existsSync(talkRaw) ? talkRaw : null, chosen)
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).message}\n`)
  process.exit(1)
})
