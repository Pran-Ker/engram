// e2e for web/index.html + web/server.py. Run: node web/qa/e2e.mjs  (server must be up on BASE)
// Needs a quiet fake mic: MIC_WAV = 48 kHz 16-bit mono WAV at ~0.25 amplitude (Chromium's default fake tone clips).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const pw = (() => { try { return require('playwright'); } catch { return require(path.join(execSync('npm root -g').toString().trim(), 'playwright')); } })();

const BASE = process.env.BASE || 'http://127.0.0.1:4311';
const MIC_WAV = process.env.MIC_WAV || '/tmp/voice-qa-mic.wav';
const QA = path.dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const state = async () => (await fetch(BASE + '/api/state')).json();

const browser = await pw.chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required',
    '--use-file-for-fake-audio-capture=' + MIC_WAV],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] });
const page = await ctx.newPage();
const consoleErrors = [], pageErrors = [];
let expectedAbort = false; // true only while the deliberate route-abort (server-unreachable test) is active
const netErr = t => /ERR_FAILED|Failed to load resource/.test(t);
page.on('console', m => { if (m.type() === 'error' && !(expectedAbort && netErr(m.text()))) consoleErrors.push(m.text()); });
page.on('pageerror', e => pageErrors.push(String(e)));
page.on('requestfailed', r => { if (!(expectedAbort && r.url().includes('/api/take/6'))) consoleErrors.push('requestfailed ' + r.url() + ' ' + (r.failure() || {}).errorText); });

const s0 = await state();
const prompts = s0.prompts;
check('state: 733 prompts', prompts.length === 733, String(prompts.length));

await page.goto(BASE + '/');
await page.waitForFunction(() => document.querySelectorAll('#list .row').length > 0);
await page.waitForFunction(() => /\S/.test(document.querySelector('#mic').textContent) && document.querySelector('#mic').textContent !== 'mic —', null, { timeout: 5000 }).catch(() => {});
const hash0 = await page.evaluate(() => location.hash);
const cur0 = +new URLSearchParams(hash0.slice(1)).get('s');
check('sentence 0 shown', cur0 === 0, hash0);
const sent0 = await page.$eval('#sentence', e => e.textContent);
check('sentence text equals first prompt line', sent0 === prompts[0], JSON.stringify(sent0.slice(0, 50)));
const blank = await page.$eval('#verdict', e => e.textContent);
check('blank-state verdict copy (needs empty RAW_DIR)', s0.count === 0 && blank.startsWith('Space to record.'), s0.count ? `skipped: ${s0.count} take(s) already in RAW_DIR — ` + blank : blank);
const micName = await page.$eval('#mic', e => e.textContent);
check('mic name shown', micName && micName !== 'mic —', micName);
const rateTagHidden = await page.$eval('#rate', e => e.hidden);
const ctxRate = await page.evaluate(() => A.rate);
check('audio ready at 48 kHz (rate tag hidden)', rateTagHidden, 'ctx rate ' + ctxRate);

// record
await page.keyboard.press('Space');
await sleep(300);
const recOn = await page.$eval('#rec', e => e.className);
check('REC dot on while recording', recOn === 'on', recOn);
const recVerdict = await page.$eval('#verdict', e => e.textContent);
check('verdict says recording', /recording/.test(recVerdict), recVerdict);
await sleep(1500);
if (await page.evaluate(() => A.recording)) await page.keyboard.press('Space');
await sleep(200);
const vis = await page.$eval('#verdict', e => { const r = e.getBoundingClientRect(); return getComputedStyle(e).visibility !== 'hidden' && r.width > 0 && r.height > 0 && e.textContent.trim().length > 0; });
const verdict = await page.$eval('#verdict', e => e.textContent);
const stats = await page.$eval('#stats', e => e.textContent);
check('verdict area visible after stop', vis, verdict + ' | ' + stats);
const take = await page.evaluate(() => { const t = S.mem.get(S.cur); return t && { duration: t.duration, peak: t.peak, mismatch: t.mismatch, stoppedBy: t.stoppedBy }; });
check('take captured (1–14 s, unclipped)', take && take.duration >= 1 && take.duration <= 14 && take.peak < 0.99, JSON.stringify(take));
const waveDrawn = await page.$eval('#wave', c => { const g = c.getContext('2d'), d = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 100) n++; return n; });
check('waveform drawn on canvas', waveDrawn > 500, waveDrawn + ' bright px');

await page.screenshot({ path: path.join(QA, 'screen.png') });
console.log('screenshot -> web/qa/screen.png');

// keep
const before = (await state()).count;
await page.keyboard.press('Enter');
await sleep(150);
const armed = await page.evaluate(() => document.body.classList.contains('armed'));
check('armed (countdown ring) after Enter', armed);
await page.keyboard.press('Space'); // cancel the countdown so the next sentence does not auto-record
await sleep(100);
const armedAfter = await page.evaluate(() => document.body.classList.contains('armed') || A.recording);
check('Space during countdown cancels arming', !armedAfter);
await page.waitForFunction(() => !S.pending.length, null, { timeout: 5000 });
await sleep(200);
const after = await state();
check('/api/state count incremented', after.count === before + 1, `${before} -> ${after.count}`);
check('manifest row for p0000', after.takes['0'] && after.takes['0'].file === 'p0000.wav', JSON.stringify(after.takes['0']));
const hash1 = await page.evaluate(() => location.hash);
const cur1 = +new URLSearchParams(hash1.slice(1)).get('s');
check('#s advanced', cur1 === 1, hash1);
const top = await page.$eval('#top', e => e.innerText.replace(/\s+/g, ' '));
check(`top strip shows ${after.count} / 733 and minutes`, top.startsWith(after.count + ' / 733') && /min/.test(top), top);
const dotKept = await page.$eval('#list .row[data-i="0"]', e => e.classList.contains('kept'));
check('list dot kept for sentence 0', dotKept);

// play: on current (no take → no-op), then on the kept sentence (server wav)
await page.keyboard.press('p');
await sleep(200);
await page.keyboard.press('ArrowLeft');
await sleep(100);
check('ArrowLeft under Todo filter stays on 1 (kept 0 is filtered out)', (await page.evaluate(() => S.cur)) === 1);
await page.click('#chips button[data-f="all"]'); await sleep(50);
await page.keyboard.press('ArrowLeft');
await sleep(100);
check('All filter + ArrowLeft moves back to kept sentence 0', (await page.evaluate(() => S.cur)) === 0);
await page.evaluate(() => { wavCache.clear(); S.mem.delete(0); });
const [wavReq] = await Promise.all([
  page.waitForResponse(r => r.url().includes('/api/take/0.wav'), { timeout: 3000 }).catch(() => null),
  page.keyboard.press('p'),
]);
check('P fetches /api/take/0.wav for a kept sentence', !!wavReq && wavReq.status() === 200, wavReq ? String(wavReq.status()) : 'no request');
await sleep(300);
const kv = await page.$eval('#verdict', e => e.textContent);
check('kept sentence verdict', /kept/.test(kv), kv);

// arrows respect filter: back to Todo; from 0 (kept, shown because current) → right → 1 → 2
await page.click('#chips button[data-f="todo"]'); await sleep(50);
await page.keyboard.press('ArrowRight'); await sleep(50);
await page.keyboard.press('ArrowRight'); await sleep(50);
const cur2 = await page.evaluate(() => S.cur);
const hash2 = await page.evaluate(() => location.hash);
check('ArrowRight x2 → sentence 2, hash updated', cur2 === 2 && hash2 === '#s=2&f=todo', hash2);
const sent2 = await page.$eval('#sentence', e => e.textContent);
check('sentence 2 text matches prompt', sent2 === prompts[2]);
const curRowVisible = await page.$eval('#list .row.cur', r => { const L = r.parentElement, a = r.getBoundingClientRect(), b = L.getBoundingClientRect(); return a.top >= b.top && a.bottom <= b.bottom; });
check('current row visible in list', curRowVisible);

// skip
await page.keyboard.press('s'); await sleep(300);
const st = await state();
check('S skips sentence 2 and advances', st.skipped.includes(2) && (await page.evaluate(() => S.cur)) === 3, JSON.stringify(st.skipped));
await page.keyboard.press('ArrowLeft'); await sleep(50);
check('skipped row hidden under Todo filter; ArrowLeft goes to 1', (await page.evaluate(() => S.cur)) === 1);

// help overlay
await page.keyboard.press('?'); await sleep(50);
check('? opens help', !(await page.$eval('#help', e => e.hidden)));
await page.keyboard.press('Escape'); await sleep(50);
check('Esc closes help', await page.$eval('#help', e => e.hidden));

// filters via chips
await page.click('#chips button[data-f="done"]'); await sleep(50);
const doneRows = await page.$$eval('#list .row:not(.hide)', rs => rs.map(r => +r.dataset.i));
const keptIdx = Object.keys((await state()).takes).map(Number);
check('Done filter shows kept + current', doneRows.includes(0) && keptIdx.every(i => doneRows.includes(i)) && doneRows.length <= keptIdx.length + 1, JSON.stringify(doneRows) + ' kept ' + JSON.stringify(keptIdx));
await page.click('#chips button[data-f="all"]'); await sleep(50);
check('All filter shows 733 rows', (await page.$$eval('#list .row:not(.hide)', rs => rs.length)) === 733);
await page.click('#chips button[data-f="todo"]'); await sleep(50);

// URL restore + longest sentence fit
const longest = prompts.reduce((a, p, i) => (p.length > prompts[a].length ? i : a), 0);
await page.goto(BASE + '/#s=' + longest + '&f=all');
await page.waitForFunction(() => document.querySelectorAll('#list .row').length > 0);
await sleep(200);
check('URL restore lands on #s', (await page.evaluate(() => S.cur)) === longest, 'longest idx ' + longest + ' (' + prompts[longest].length + ' chars)');
const fit = await page.evaluate(() => { const s = document.querySelector('#sentence').getBoundingClientRect(), st = document.querySelector('#stage').getBoundingClientRect(), c = document.querySelector('#center').getBoundingClientRect(); return { sh: s.height, stH: st.height, inside: s.height <= st.height + 1 && s.right <= c.right && s.left >= c.left, lines: Math.round(s.height / parseFloat(getComputedStyle(document.querySelector('#sentence')).lineHeight)) }; });
check('longest sentence fits in stage', fit.inside, JSON.stringify(fit));
const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);
check('no horizontal scroll at 1440', noHScroll);
await page.screenshot({ path: path.join(QA, 'screen-longest.png') });

// redo an already-kept sentence: 0 → Space, record, Enter replaces; manifest stays at one row for p0000
await page.goto(BASE + '/#s=0&f=all');
await page.waitForFunction(() => document.querySelectorAll('#list .row').length > 0);
await sleep(300);
await page.keyboard.press('Space'); await sleep(1600);
if (await page.evaluate(() => A.recording)) await page.keyboard.press('Space');
await sleep(200);
const cntBefore = (await state()).count;
await page.keyboard.press('Enter'); await sleep(150);
await page.keyboard.press('Space'); // cancel arm
await page.waitForFunction(() => !S.pending.length, null, { timeout: 5000 });
await sleep(200);
const s3 = await state();
check('redo keeps count unchanged (row replaced)', s3.count === cntBefore, `${cntBefore} -> ${s3.count}`);
const manifest = (await import('node:fs')).readFileSync((process.env.RAW_DIR || '/tmp/voice-qa-raw') + '/manifest.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l));
const p0 = manifest.filter(r => r.file === 'p0000.wav');
check('manifest has exactly one p0000 row, asr null, text = prompt', p0.length === 1 && p0[0].asr === null && p0[0].text === prompts[0] && p0[0].sample_rate === 48000, JSON.stringify(p0.map(r => ({ asr: r.asr, mismatch: r.mismatch, duration_s: r.duration_s, peak: r.peak }))));

// clipped take cannot be kept
await page.goto(BASE + '/#s=4&f=todo'); await sleep(200);
await page.evaluate(() => { const pcm = new Float32Array(RATE * 2); pcm.fill(1); S.mem.set(4, { pcm, duration: 2, peak: 1, wav: encodeWav(pcm), kept: false, words: 5, srUsed: false, asr: null, matched: [], mismatch: 0, stoppedBy: 'manual' }); renderFeedback(); });
const clipV = await page.$eval('#verdict', e => e.textContent);
const cntClip = (await state()).count;
await page.keyboard.press('Enter'); await sleep(300);
check('clipped take: verdict says redo, Enter refused, count unchanged', /clipped — redo/.test(clipV) && (await state()).count === cntClip && (await page.evaluate(() => S.cur)) === 4, clipV);
await page.keyboard.press('Escape'); await sleep(50);

// server unreachable: take held in memory, banner + Retry re-POSTs
await page.goto(BASE + '/#s=6&f=todo'); await sleep(200);
expectedAbort = true;
await page.route('**/api/take/6*', r => r.abort());
await page.keyboard.press('Space'); await sleep(1600);
if (await page.evaluate(() => A.recording)) await page.keyboard.press('Space');
await sleep(200);
const cntOff = (await state()).count;
await page.keyboard.press('Enter'); await sleep(150);
await page.keyboard.press('Space'); await sleep(400);
const bannerTxt = await page.$eval('#banner', e => (e.hidden ? '' : e.textContent));
const shownCount = await page.$eval('#count', e => e.textContent);
check('offline: banner shows take held in memory, optimistic count reverted', /1 take held in memory/.test(bannerTxt) && shownCount.startsWith(cntOff + ' /') && (await state()).count === cntOff, bannerTxt + ' | ' + shownCount);
await page.unroute('**/api/take/6*');
await sleep(100); expectedAbort = false;
await page.click('#bannerBtn');
await page.waitForFunction(() => !S.pending.length, null, { timeout: 5000 }); await sleep(200);
const sRetry = await state();
check('Retry re-POSTs the held take; banner gone', sRetry.count === cntOff + 1 && !!sRetry.takes['6'] && (await page.$eval('#banner', e => e.hidden)), `${cntOff} -> ${sRetry.count}`);

// 900 wide usability
await page.setViewportSize({ width: 900, height: 700 });
await sleep(200);
const ok900 = await page.evaluate(() => { const k = document.querySelector('#keys').getBoundingClientRect(), l = document.querySelector('#list').getBoundingClientRect(); return { hscroll: document.documentElement.scrollWidth > window.innerWidth, keysBottom: k.bottom, inner: window.innerHeight, listBottom: l.bottom, keysTop: k.top }; });
check('900x700: no h-scroll, list clipped above keys', !ok900.hscroll && ok900.keysBottom <= ok900.inner + 1 && ok900.listBottom <= ok900.keysTop + 1, JSON.stringify(ok900));
await page.screenshot({ path: path.join(QA, 'screen-900.png') });

await sleep(300);
check('no console errors', consoleErrors.length === 0, JSON.stringify(consoleErrors));
check('no page errors', pageErrors.length === 0, JSON.stringify(pageErrors));

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
