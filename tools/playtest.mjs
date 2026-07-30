// Play every map with the baseline bot and report whether it survives.
//
//   node tools/playtest.mjs [baseUrl] [waves] [speed]
//
// Each run opens its own tab, lets the bot play at N sim substeps per frame,
// polls the in-page heartbeat until the run resolves, and prints a verdict
// table. This is the difference between "I think map 3 is too hard" and knowing.

import { spawn } from 'node:child_process';
import { MAPS } from '../src/maps.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:8099/';
const WAVES = Number(process.argv[3]) || 0;   // 0 = use each map's own target
const SPEED = Number(process.argv[4]) || 8;
const TIMEOUT_MS = 180000;

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `C:/Users/${process.env.USERNAME ?? ''}/AppData/Local/Google/Chrome/Application/chrome.exe`,
].find(existsSync);
if (!CHROME) { console.error('chrome not found'); process.exit(2); }

const PORT = 9334;
const child = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${join(process.env.TEMP ?? '.', 'orcflow-playtest-profile')}`,
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

class Tab {
  static async open(url) {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    const info = await r.json();
    const ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    return new Tab(info, ws);
  }

  constructor(info, ws) {
    this.info = info; this.ws = ws; this.id = 0; this.pending = new Map(); this.logs = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m.result); this.pending.delete(m.id); }
      else if (m.method === 'Runtime.exceptionThrown') {
        this.logs.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
      }
    });
    this.call('Runtime.enable');
  }

  call(method, params = {}) {
    return new Promise((res) => {
      const id = ++this.id;
      this.pending.set(id, res);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async state() {
    const r = await this.call('Runtime.evaluate', {
      expression: 'JSON.stringify(globalThis.__orcflow ? globalThis.__orcflow() : null)',
      returnByValue: true,
    });
    try { return JSON.parse(r?.result?.value ?? 'null'); } catch { return null; }
  }

  async close() {
    this.ws.close();
    try { await fetch(`http://127.0.0.1:${PORT}/json/close/${this.info.id}`); } catch {}
  }
}

async function playMap(map) {
  const url = `${BASE}?autoplay=1&speed=${SPEED}&map=${map}${WAVES ? `&waves=${WAVES}` : ''}`;
  const tab = await Tab.open(url);
  const started = Date.now();
  let last = null;
  try {
    for (;;) {
      await sleep(1000);
      const s = await tab.state();
      if (s) {
        last = s;
        if (s.lastError) return { map, verdict: 'ERROR', detail: s.lastError.split('\n')[0], ...s };
        if (s.over) {
          return {
            map,
            verdict: s.won ? 'WIN' : 'LOSS',
            wall: ((Date.now() - started) / 1000).toFixed(0) + 's',
            ...s,
          };
        }
      }
      if (Date.now() - started > TIMEOUT_MS) {
        return { map, verdict: 'TIMEOUT', ...(last ?? {}) };
      }
    }
  } finally {
    await tab.close();
  }
}

await waitForBrowser();

const ONLY = process.argv[5] ? process.argv[5].split(',').map(Number) : null;
const maps = ONLY ?? MAPS.map((_, i) => i);
const results = [];
for (const map of maps) {
  process.stdout.write(`playing map ${map} ... `);
  const r = await playMap(map);
  console.log(`${r.verdict}  wave ${r.wave ?? '?'}/${r.target ?? WAVES}  hp ${Math.max(0, Math.ceil(r.hp ?? 0))}  kills ${(r.kills ?? 0).toLocaleString()}  turrets ${r.turrets ?? 0}  ${r.wall ?? ''}${r.detail ? '  ' + r.detail : ''}`);
  results.push(r);
}

console.log('\n=== verdicts ===');
for (const r of results) {
  console.log(`map ${r.map}: ${r.verdict.padEnd(7)} reached wave ${r.wave ?? '?'} of ${r.target ?? WAVES}, ${(r.kills ?? 0).toLocaleString()} kills, hp ${Math.max(0, Math.ceil(r.hp ?? 0))}`);
}
const wins = results.filter((r) => r.verdict === 'WIN').length;
console.log(`\n${wins}/${results.length} maps survivable by the baseline bot at their own wave targets.`);

try { child.kill(); } catch {}
process.exit(results.some((r) => r.verdict === 'ERROR') ? 1 : 0);
