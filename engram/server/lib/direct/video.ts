// Direct mode face: one photo (and optionally one existing talking clip) become the idle/talk loops the stage expects.
// Letterboxes onto the page background instead of cropping, so a square headshot keeps the whole face.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SIZE = '1920x1080'
const BG = '0x0b0b0c'
const FPS = 30
const IDLE_SECONDS = 10
const ENC = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-crf', '18', '-preset', 'fast', '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-movflags', '+faststart', '-an']
const LETTERBOX = `scale=${SIZE.replace('x', ':')}:force_original_aspect_ratio=decrease,pad=${SIZE.replace('x', ':')}:(ow-iw)/2:(oh-ih)/2:color=${BG}`

const ff = (args: string[]) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'inherit', 'inherit'] })

export type Loops = { idle: string; talk: string; poster: string; talkFrom: 'clip' | 'idle' }

/** Writes video/idle.mp4 (breathing zoom on the photo), video/talk.mp4 (the clip, or the idle loop again) and video/poster.jpg. */
export function buildLoops(dir: string, photo: string, clip?: string): Loops {
  const video = join(dir, 'video')
  mkdirSync(video, { recursive: true })
  const idle = join(video, 'idle.mp4'), talk = join(video, 'talk.mp4'), poster = join(video, 'poster.jpg')
  const frames = IDLE_SECONDS * FPS
  const zoom = `1.02+0.012*sin(2*PI*on/${frames})`
  ff([
    '-loop', '1', '-framerate', String(FPS), '-i', photo,
    '-vf', `${LETTERBOX},zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)+4*sin(2*PI*on/${frames})':d=1:s=${SIZE}:fps=${FPS},format=yuv420p`,
    '-frames:v', String(frames), ...ENC, idle,
  ])
  ff(['-i', idle, '-frames:v', '1', '-q:v', '2', poster])
  if (clip) ff(['-i', clip, '-vf', `${LETTERBOX},fps=${FPS},format=yuv420p`, ...ENC, talk])
  else copyFileSync(idle, talk)
  return { idle: 'video/idle.mp4', talk: 'video/talk.mp4', poster: 'video/poster.jpg', talkFrom: clip ? 'clip' : 'idle' }
}
