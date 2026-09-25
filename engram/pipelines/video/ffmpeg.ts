import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const ENC = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-crf', '18', '-preset', 'slow', '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-movflags', '+faststart', '-an']

const BG_GREY = 14
const SOURCE_TAGS = 'setparams=colorspace=bt709:range=tv'
const OUTPUT_TAGS = 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv'
const FEATHER = { x: 0.12, y: 0.16 }

function ff(args: string[]) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'inherit', 'inherit'] })
}

function edgeMask(size: string) {
  const [w, h] = size.split('x').map(Number)
  const out = join(tmpdir(), `engram-edge-${size}.png`)
  if (existsSync(out)) return out
  const fx = Math.round(w * FEATHER.x)
  const fy = Math.round(h * FEATHER.y)
  const t = `st(0,clip(min(min(X/${fx},(${w - 1}-X)/${fx}),Y/${fy}),0,1));255*ld(0)*ld(0)*(3-2*ld(0))`
  ff(['-f', 'lavfi', '-i', `color=c=white:s=${size}`, '-frames:v', '1', '-vf', `format=gray,geq=lum='${t}'`, out])
  return out
}

function melt(size: string, black: number, grey: number) {
  const hex = `0x${grey.toString(16).padStart(2, '0').repeat(3)}`
  const lift = `lutrgb=r='max(val,${black})':g='max(val,${black})':b='max(val,${black})',colorlevels=rimin=${(black / 255).toFixed(4)}:gimin=${(black / 255).toFixed(4)}:bimin=${(black / 255).toFixed(4)}:romin=${(grey / 255).toFixed(4)}:gomin=${(grey / 255).toFixed(4)}:bomin=${(grey / 255).toFixed(4)}`
  return {
    inputs: ['-loop', '1', '-framerate', '30', '-i', edgeMask(size), '-f', 'lavfi', '-i', `color=c=${hex}:s=${size}:r=30,format=rgb24`],
    tail: `[v]${SOURCE_TAGS},format=rgb24,${lift}[c];[c][1:v]alphamerge=shortest=1[m];[2:v][m]overlay=shortest=1:format=rgb,${OUTPUT_TAGS}[out]`,
  }
}

function fit(size: string) {
  return `scale=${size}:force_original_aspect_ratio=increase,crop=${size.replace('x', ':')},setsar=1`
}

export type Probe = { width: number; height: number; fps: number; duration: number; frames: number }

export function probe(path: string): Probe {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=width,height,r_frame_rate,duration,nb_read_frames', '-of', 'json', path]).toString()
  const s = JSON.parse(out).streams[0]
  const [n, d] = String(s.r_frame_rate).split('/').map(Number)
  return { width: s.width, height: s.height, fps: n / (d || 1), duration: Number(s.duration), frames: Number(s.nb_read_frames) }
}

export function pingPong(src: string, out: string, size: string, black = 20, grey = BG_GREY) {
  mkdirSync(dirname(out), { recursive: true })
  const m = melt(size, black, grey)
  ff([
    '-i', src, ...m.inputs,
    '-filter_complex', `[0:v]${fit(size)},split[a][b];[b]reverse,trim=start_frame=1,setpts=PTS-STARTPTS[r];[a][r]concat=n=2:v=1:a=0,fps=30[v];${m.tail}`,
    '-map', '[out]', ...ENC, out,
  ])
}

export function crossfadeLoop(src: string, out: string, size: string, black = 20, grey = BG_GREY, fade = 0.5) {
  mkdirSync(dirname(out), { recursive: true })
  const { duration } = probe(src)
  const body = duration - fade
  const m = melt(size, black, grey)
  ff([
    '-i', src, ...m.inputs,
    '-filter_complex',
    `[0:v]${fit(size)},fps=30[s];[s]split[a][b];[a]trim=start=${fade},setpts=PTS-STARTPTS[main];[b]trim=duration=${fade},setpts=PTS-STARTPTS[head];[main][head]xfade=transition=fade:duration=${fade}:offset=${(body - fade).toFixed(3)}[v];${m.tail}`,
    '-map', '[out]', ...ENC, out,
  ])
}

export function stillToIdle(portrait: string, out: string, size: string, black = 20, grey = BG_GREY, seconds = 8) {
  mkdirSync(dirname(out), { recursive: true })
  const [w, h] = size.split('x').map(Number)
  const frames = seconds * 30
  const zoom = `1.02+0.012*sin(2*PI*on/${frames})`
  const m = melt(size, black, grey)
  ff([
    '-loop', '1', '-framerate', '30', '-i', portrait, ...m.inputs,
    '-filter_complex', `[0:v]scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase,crop=${w * 2}:${h * 2},zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)+6*sin(2*PI*on/${frames})':d=1:s=${size}:fps=30[v];${m.tail}`,
    '-frames:v', String(frames), '-map', '[out]', ...ENC, out,
  ])
}

export function frame(src: string, out: string, at: 'first' | 'last') {
  mkdirSync(dirname(out), { recursive: true })
  if (at === 'first') ff(['-i', src, '-frames:v', '1', '-q:v', '2', out])
  else ff(['-sseof', '-0.05', '-i', src, '-update', '1', '-q:v', '2', out])
}

export function poster(src: string, out: string) {
  frame(src, out, 'first')
}

export function psnr(a: string, b: string): number {
  const r = spawnSync('ffmpeg', ['-loglevel', 'info', '-i', a, '-i', b, '-lavfi', 'psnr', '-f', 'null', '-'], { encoding: 'utf8' })
  const m = /average:(inf|\d+(?:\.\d+)?)/.exec(r.stderr)
  if (!m) return 0
  return m[1] === 'inf' ? 99 : Number(m[1])
}

export function edges(path: string) {
  const [l, r, t] = ['40:ih:0:0', '40:ih:iw-40:0', 'iw:40:0:0'].map((c) => {
    const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', path, '-frames:v', '1', '-vf', `crop=${c},scale=1:1:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
    return [raw[0], raw[1], raw[2]]
  })
  return { left: l, right: r, top: t }
}
