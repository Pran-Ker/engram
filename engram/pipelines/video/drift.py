# /// script
# requires-python = ">=3.11"
# dependencies = ["opencv-python-headless>=4.9,<5", "numpy>=1.26"]
# ///
import json
import sys

import cv2
import numpy as np

SCALES = np.arange(0.85, 1.40, 0.01)
CASCADE = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
TORSO_ROW = 0.93
TORSO_LUMA = 24


def read_frames(path, every):
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    frames = []
    n = 0
    while True:
        ok, img = cap.read()
        if not ok:
            break
        if n % every == 0:
            frames.append((n, img))
        n += 1
    cap.release()
    return fps, n, frames


def frame_at(path, t):
    cap = cv2.VideoCapture(path)
    cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
    ok, img = cap.read()
    cap.release()
    return img


def half_gray(img):
    return cv2.cvtColor(cv2.resize(img, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)


def face_box(gray):
    faces = CASCADE.detectMultiScale(gray, 1.1, 5, minSize=(120, 120))
    if len(faces) == 0:
        h, w = gray.shape
        return (w // 2 - w // 8, h // 2 - h // 6, w // 4, h // 3)
    return max(faces, key=lambda f: f[2] * f[3])


def upper_face(gray, box):
    x, y, w, h = box
    return gray[y:y + int(h * 0.62), x:x + w], (x + w / 2, y + h * 0.31)


def match(gray, template):
    best = (-1, 1.0, (0, 0))
    th, tw = template.shape
    for s in SCALES:
        t = cv2.resize(template, (max(8, int(tw * s)), max(8, int(th * s))), interpolation=cv2.INTER_AREA)
        if t.shape[0] >= gray.shape[0] or t.shape[1] >= gray.shape[1]:
            continue
        r = cv2.matchTemplate(gray, t, cv2.TM_CCOEFF_NORMED)
        _, score, _, loc = cv2.minMaxLoc(r)
        if score > best[0]:
            best = (score, float(s), (loc[0] + t.shape[1] / 2, loc[1] + t.shape[0] / 2))
    return best


def torso_width(img):
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    row = gray[int(gray.shape[0] * TORSO_ROW)]
    lit = np.flatnonzero(row > TORSO_LUMA)
    return int(lit[-1] - lit[0] + 1) if len(lit) else 0


def measure(path, every=6):
    fps, total, frames = read_frames(path, every)
    g0 = half_gray(frames[0][1])
    box = face_box(g0)
    template, _ = upper_face(g0, box)
    samples = []
    for n, img in frames:
        score, s, (cx, cy) = match(half_gray(img), template)
        samples.append({'n': n, 's': round(s, 3), 'cx': cx * 2, 'cy': cy * 2, 'score': round(float(score), 3)})
    ns = np.array([x['n'] for x in samples], dtype=float)
    fit = lambda key: [float(c) for c in np.polyfit(ns, [x[key] for x in samples], 2)[::-1]]
    return {
        'path': path,
        'fps': fps,
        'frames': total,
        'face': [int(v) * 2 for v in box],
        'samples': samples,
        'fit': {'s': fit('s'), 'cx': fit('cx'), 'cy': fit('cy')},
        'maxScale': max(x['s'] for x in samples),
        'minScale': min(x['s'] for x in samples),
    }


def compare(out, paths, times):
    strips = []
    rows = []
    for path in paths:
        img0 = frame_at(path, 0)
        g0 = half_gray(img0)
        box = face_box(g0)
        template, center0 = upper_face(g0, box)
        torso0 = torso_width(img0)
        x, y, w, h = [int(v) * 2 for v in box]
        tiles = []
        for t in times:
            img = frame_at(path, t)
            _, s, (cx, cy) = match(half_gray(img), template)
            torso = torso_width(img) / torso0 if torso0 else 0
            eyes_dy = (cy - center0[1]) * 2
            tile = img.copy()
            left, top = int(cx * 2 - w * s / 2), int(cy * 2 - h * 0.31 * s)
            cv2.rectangle(tile, (left, top), (int(left + w * s), int(top + h * s)), (60, 220, 90), 3)
            torso_y = int(tile.shape[0] * TORSO_ROW)
            cv2.line(tile, (0, torso_y), (tile.shape[1], torso_y), (90, 160, 255), 2)
            tile = cv2.resize(tile, (640, 360), interpolation=cv2.INTER_AREA)
            label = f'{path.split("/")[-1]}  t={t:.0f}s   face {s:.3f}   eyes dy {eyes_dy:+.0f}px   torso {torso:.3f}'
            cv2.putText(tile, label, (12, 344), cv2.FONT_HERSHEY_SIMPLEX, 0.52, (255, 255, 255), 1, cv2.LINE_AA)
            tiles.append(tile)
            rows.append({'clip': path, 't': t, 'face': round(s, 3), 'eyesDy': round(eyes_dy), 'torso': round(torso, 3)})
        strips.append(np.hstack(tiles))
    cv2.imwrite(out, np.vstack(strips), [cv2.IMWRITE_JPEG_QUALITY, 88])
    return rows


if __name__ == '__main__':
    cmd, *rest = sys.argv[1:]
    if cmd == 'measure':
        print(json.dumps(measure(rest[0])))
    elif cmd == 'compare':
        out, times, *paths = rest
        print(json.dumps(compare(out, paths, [float(t) for t in times.split(',')])))
