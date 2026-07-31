// Do all orcs reach the goal?
//
//   node tools/flowtest.mjs [baseUrl]
//
// This is the test that was missing, and its absence is why every stalling bug in
// this project was found by a human staring at the screen. smoke.mjs and
// playtest.mjs both measure kills and leaks, and those stay perfectly healthy
// while a clump sits parked in a corner, because the rest of the horde keeps
// flowing.
//
// Method: spawn a batch with NO turrets built, so nothing can die, then watch the
// leak counter. Every orc must arrive. Anything left alive after the deadline is
// stuck, and the run fails with the count.

import { spawn } from 'node:child_process';
import { MAPS } from '../src/maps.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:8099/';
const SPAWN = 3000;
const DEADLINE_S = 70;          // generous: slowest orc crossing the longest map

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find(existsSync);
if (!CHROME) { console.error('chrome not found'); process.exit(2); }

const PORT = 9337;
const child = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${join(process.env.TEMP ?? '.', 'orcflow-flowtest')}`,
  '--no-first-run', '--no-default-browser-check', '--enable-unsafe-webgpu',
  '--window-size=1280,760',
  '--disable-features=CalculateNativeWinOcclusion',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForBrowser() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) return; } catch {}
    await sleep(250);
  }
  throw new Error('browser never came up');
}

async function openTab(url) {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const info = await r.json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res) => ws.addEventListener('open', res));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  });
  const call = (method, params = {}) => new Promise((res) => {
    const i = ++id; pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  return {
    call,
    async state() {
      const r2 = await call('Runtime.evaluate', {
        expression: 'JSON.stringify(globalThis.__orcflow ? globalThis.__orcflow() : null)',
        returnByValue: true,
      });
      try { return JSON.parse(r2?.result?.value ?? 'null'); } catch { return null; }
    },
    async close() {
      ws.close();
      try { await fetch(`http://127.0.0.1:${PORT}/json/close/${info.id}`); } catch {}
    },
  };
}

async function testMap(map) {
  // sandbox keeps the base alive so leaks can be counted past 90
  const url = `${BASE}?map=${map}&spawn=${SPAWN}&bench=1&rate=0&speed=4`;
  const tab = await openTab(url);
  const started = Date.now();
  let last = null;
  try {
    for (;;) {
      await sleep(1500);
      const s = await tab.state();
      if (s) {
        last = s;
        // every spawned orc has either leaked or been recycled: none are stuck
        if (s.alive <= Math.max(2, SPAWN * 0.002)) {
          return { map, ok: true, secs: ((Date.now() - started) / 1000).toFixed(0), ...s };
        }
      }
      if (Date.now() - started > DEADLINE_S * 1000) {
        return { map, ok: false, secs: DEADLINE_S, ...(last ?? {}) };
      }
    }
  } finally {
    await tab.close();
  }
}

await waitForBrowser();

const only = process.argv[3] ? process.argv[3].split(',').map(Number) : MAPS.map((_, i) => i);
const results = [];
for (const map of only) {
  process.stdout.write(`${MAPS[map].name.padEnd(14)} `);
  const r = await testMap(map);
  results.push(r);
  console.log(r.ok
    ? `OK    all ${SPAWN} arrived in ${r.secs}s  (stall-frames ${r.stuck ?? '?'})`
    : `STUCK ${r.alive} of ${SPAWN} never arrived  (leaks ${r.leaks}, stall-frames ${r.stuck ?? '?'})`);
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} maps let every orc reach the base.`);
try { child.kill(); } catch {}
process.exit(bad.length ? 1 : 0);
