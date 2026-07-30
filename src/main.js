// ORCFLOW / "SIR, WE HAVE A FLOW FIELD"
// Boot, camera, input, frame loop. The CPU's whole job per frame is: advance the
// wave clock, spin turret aims, set uniforms, and draw.

import * as THREE from 'three/webgpu';
import { Field } from './field.js';
import { MAPS } from './maps.js';
import { Ground } from './ground.js';
import { Horde } from './gpu/horde.js';
import { Effects } from './effects.js';
import { Build } from './game/build.js';
import { Waves } from './game/waves.js';
import { Hud } from './hud.js';
import { makeOrcAtlas } from './art.js';
import {
  GRID_W, GRID_H, MAX_ORCS, BUILDS, BASE_HP, START_GOLD, ORC_TYPES, PARAMS, SPAWN_BATCH,
} from './config.js';

const mapIndex = Math.min(MAPS.length - 1, Math.max(0, Number(PARAMS.get('map')) || 0));
const BENCH = PARAMS.get('bench') === '1';

const state = {
  hp: BASE_HP, hpMax: BASE_HP, gold: START_GOLD,
  selected: 1, paused: false, over: false, time: 1,
  // The stress tools spawn orcs on top of the base, which would end the run in
  // one frame. Anything that floods the board turns this on.
  sandbox: false,
};

const hud = new Hud({
  onSelect: (i) => { state.selected = i; },
  onStress: () => stress(10000),
  onFlood: () => flood(),
  onRestart: () => location.reload(),
});

if (!navigator.gpu) {
  hud.fail('This prototype needs <b>WebGPU</b>.<br>Firefox 141+ on Windows, Chrome, or Edge.');
  throw new Error('no WebGPU');
}

const field = new Field(MAPS[mapIndex]);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0906);

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
camera.position.set(GRID_W / 2, GRID_H / 2, 10);

const renderer = new THREE.WebGPURenderer({ antialias: false, trackTimestamp: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
document.body.appendChild(renderer.domElement);

try {
  await renderer.init();
} catch (err) {
  hud.fail(`WebGPU failed to start:<br><code>${err.message}</code>`);
  throw err;
}

// ---- world ------------------------------------------------------------------
const flowTex = new THREE.DataTexture(field.flow, GRID_W, GRID_H, THREE.RGBAFormat, THREE.UnsignedByteType);
flowTex.magFilter = THREE.NearestFilter;
flowTex.minFilter = THREE.NearestFilter;
flowTex.generateMipmaps = false;
flowTex.needsUpdate = true;

const ground = new Ground(field);
scene.add(ground.mesh);

const horde = new Horde(renderer, flowTex, makeOrcAtlas(), field.base);
await horde.init();
scene.add(horde.mesh);

const effects = new Effects(scene);
const build = new Build(field, ground, horde);
const waves = new Waves(field, horde);

// A rebake rewrites field.flow in place, so the GPU just needs the upload flag.
const refreshField = () => { flowTex.needsUpdate = true; };

// ---- camera fit -------------------------------------------------------------
let zoom = 1;
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h);
  const aspect = w / h;
  const worldAspect = GRID_W / GRID_H;
  let vw, vh;
  if (aspect > worldAspect) { vh = GRID_H; vw = vh * aspect; } else { vw = GRID_W; vh = vw / aspect; }
  camera.left = -vw / 2; camera.right = vw / 2;
  camera.top = vh / 2; camera.bottom = -vh / 2;
  camera.zoom = zoom;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---- input ------------------------------------------------------------------
const pointer = { x: 0, y: 0, world: null, panning: false, px: 0, py: 0 };

function toWorld(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  const v = new THREE.Vector3(
    ((ev.clientX - r.left) / r.width) * 2 - 1,
    -((ev.clientY - r.top) / r.height) * 2 + 1,
    0,
  );
  v.unproject(camera);
  return { x: v.x, y: v.y };
}

renderer.domElement.addEventListener('pointermove', (ev) => {
  pointer.world = toWorld(ev);
  if (pointer.panning) {
    const k = (camera.right - camera.left) / camera.zoom / innerWidth;
    camera.position.x -= (ev.clientX - pointer.px) * k;
    camera.position.y += (ev.clientY - pointer.py) * k;
    pointer.px = ev.clientX; pointer.py = ev.clientY;
  }
});

renderer.domElement.addEventListener('pointerdown', (ev) => {
  if (ev.button === 2 || ev.button === 1) {
    pointer.panning = true; pointer.px = ev.clientX; pointer.py = ev.clientY;
    return;
  }
  if (ev.button !== 0 || state.over) return;
  const b = BUILDS[state.selected];
  const world = toWorld(ev);
  if (state.gold < b.cost) { hud.toast('not enough gold'); return; }
  const err = build.place(world, b);
  if (err) { hud.toast(err); return; }
  state.gold -= b.cost;
  refreshField();
});

addEventListener('pointerup', () => { pointer.panning = false; });
renderer.domElement.addEventListener('contextmenu', (ev) => ev.preventDefault());

renderer.domElement.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const before = toWorld(ev);
  zoom = Math.min(6, Math.max(0.75, zoom * (ev.deltaY < 0 ? 1.12 : 1 / 1.12)));
  camera.zoom = zoom;
  camera.updateProjectionMatrix();
  const after = toWorld(ev);
  camera.position.x += before.x - after.x;
  camera.position.y += before.y - after.y;
}, { passive: false });

addEventListener('keydown', (ev) => {
  const i = BUILDS.findIndex((b) => b.key === ev.key);
  if (i >= 0) { state.selected = i; return; }
  if (ev.code === 'Space') {
    ev.preventDefault();
    if (waves.call()) hud.toast(`wave ${waves.wave}`);
  } else if (ev.key === 'p' || ev.key === 'P') {
    state.paused = !state.paused;
    hud.toast(state.paused ? 'paused' : 'running');
  } else if (ev.key === 'g' || ev.key === 'G') {
    if (state.sandbox) { state.sandbox = false; hud.toast('sandbox off'); }
    else { enterSandbox(); hud.toast('sandbox on: base invulnerable'); }
  } else if (ev.key === 'm' || ev.key === 'M') {
    const next = (mapIndex + 1) % MAPS.length;
    location.search = `?map=${next}${BENCH ? '&bench=1' : ''}`;
  } else if (ev.key === 'r' || ev.key === 'R') {
    location.reload();
  }
});

// ---- stress helpers ---------------------------------------------------------
// Benchmark spawns are not an attack on the player: they make the base
// invulnerable so a flood cannot instantly end the run.
function enterSandbox() {
  if (state.sandbox) return;
  state.sandbox = true;
  state.over = false;
  state.hp = state.hpMax;
  document.getElementById('over').classList.remove('show');
}

function stress(n) {
  enterSandbox();
  const t = ORC_TYPES[0];
  let left = n;
  while (left > 0) {
    const c = Math.min(SPAWN_BATCH, left);
    left -= c;
    horde.spawn(c, {
      pos: field.spawns[0], hp: t.hp, type: 0, speed: t.speed,
      gold: t.gold, scale: t.scale, spread: 2.4,
    });
  }
  hud.toast(horde.stats.spawned > MAX_ORCS ? `+${n} (at capacity, recycling oldest)` : `+${n} orcs`);
}

// Fill the playfield rather than the portal, for a worst-case density test.
function flood(count = Math.floor(MAX_ORCS / 2)) {
  enterSandbox();
  const t = ORC_TYPES[0];
  const centre = { x: GRID_W / 2, y: GRID_H / 2 };
  const batches = Math.max(1, Math.floor(Math.min(count, MAX_ORCS) / SPAWN_BATCH));
  for (let i = 0; i < batches; i++) {
    horde.spawn(SPAWN_BATCH, {
      pos: centre, hp: t.hp * 4, type: 0, speed: t.speed,
      gold: t.gold, scale: t.scale, spread: Math.max(GRID_W, GRID_H) / 2,
    });
  }
  hud.toast(`flooding ${batches * SPAWN_BATCH} orcs`);
}

// ---- scriptable benchmark entry points --------------------------------------
// ?spawn=N       flood N orcs at boot
// ?bench=1       keep ramping, no waves, base takes no damage
// ?rate=N        orcs added per ramp step (default 4000)
// ?autobuild=1   drop one of each turret on the path, for a damage-path run
// ?perf=1        log a frame-time distribution every 60 frames
const bench = { next: 2, step: 0, rate: Number(PARAMS.get('rate') ?? 4000) };

if (PARAMS.get('autobuild') === '1') autobuild();
if (PARAMS.get('ramparts')) dropRamparts(Number(PARAMS.get('ramparts')));

// Paint ramparts along the path through the same code a click uses, so the
// placement + rebake + reachability guard all get exercised.
function dropRamparts(n) {
  const cells = [];
  for (let y = 2; y < GRID_H - 2; y += 2) {
    for (let x = 2; x < GRID_W - 2; x += 2) {
      const c = field.cost[field.idx(x, y)];
      if (Number.isFinite(c) && !field.isWall(x, y)) cells.push({ x: x + 0.5, y: y + 0.5, c });
    }
  }
  cells.sort((a, b) => a.c - b.c);
  let placed = 0, refused = 0;
  for (let i = 0; i < cells.length && placed < n; i += 3) {
    if (build.place(cells[i], BUILDS[0])) refused++; else placed++;
  }
  refreshField();
  console.log(`[ramparts] placed ${placed}, refused ${refused} (would have sealed the path)`);
}
if (PARAMS.get('spawn')) flood(Number(PARAMS.get('spawn')));
if (PARAMS.get('wave') === '1') waves.call();   // start the real game loop headlessly

// Pick open cells a set distance along the path and drop a turret on each.
function autobuild() {
  const wanted = [
    { d: 0.2, build: BUILDS[1] },    // blades
    { d: 0.4, build: BUILDS[2] },    // beam
    { d: 0.6, build: BUILDS[3] },    // bounce
    { d: 0.8, build: BUILDS[4] },    // mortar
  ];
  const cells = [];
  for (let y = 1; y < GRID_H - 1; y += 2) {
    for (let x = 1; x < GRID_W - 1; x += 2) {
      const c = field.cost[field.idx(x, y)];
      if (Number.isFinite(c) && !field.isWall(x, y)) cells.push({ x: x + 0.5, y: y + 0.5, c });
    }
  }
  cells.sort((a, b) => a.c - b.c);
  for (const w of wanted) {
    const start = Math.floor(cells.length * w.d);
    for (let i = start; i < cells.length; i++) {
      if (!build.place(cells[i], w.build)) break;
    }
  }
  refreshField();
}

// ---- loop -------------------------------------------------------------------
let last = performance.now();
let fps = 60, msAvg = 16, frames = 0;
let computeMs = null, renderMs = null;
const window60 = [];

hud.ready();

// Heartbeat the smoke test can read back over CDP.
globalThis.__orcflow = () => ({
  frames, time: state.time, alive: horde.stats.alive, spawned: horde.stats.spawned,
  kills: horde.stats.kills, leaks: horde.stats.leaks, gold: state.gold,
  turrets: build.turrets.length, blasts: build.blasts.length,
  hp: state.hp, over: state.over, sandbox: state.sandbox,
  wave: waves.wave, waveState: waves.state,
  queued: horde._spawnQueue.length, lastError: globalThis.__orcflowError ?? null,
});

function frame(now) {
  try {
    step(now);
  } catch (err) {
    globalThis.__orcflowError = `${err.message}\n${err.stack}`;
    console.error('[frame]', err);
    return;                       // stop rather than spam once broken
  }
  requestAnimationFrame(frame);
}

function step(now) {
  const raw = (now - last) / 1000;
  last = now;
  const dt = Math.min(raw, 1 / 20);          // a hitch must not teleport the horde
  frames++;
  // Rolling window, so the readout is a real distribution and not an average
  // that a single hitch can poison.
  window60.push(raw * 1000);
  if (window60.length > 60) window60.shift();
  if (frames % 60 === 0) {
    const s = [...window60].sort((a, b) => a - b);
    msAvg = s[Math.floor(s.length / 2)];
    fps = 1000 / Math.max(msAvg, 0.01);
    if (PARAMS.get('perf') === '1') {
      console.log(`[perf] p50 ${msAvg.toFixed(2)}ms  p95 ${s[Math.floor(s.length * 0.95)].toFixed(2)}ms  max ${s[s.length - 1].toFixed(2)}ms  alive ${horde.stats.alive}  drawn ${horde.used ?? 0}  compute ${computeMs?.toFixed(2) ?? '?'}  render ${renderMs?.toFixed(2) ?? '?'}`);
    }
  }

  if (!state.paused && !state.over) {
    state.time += dt;
    if (BENCH) {
      if (state.time > bench.next) {
        bench.next += 2;
        bench.step++;
        stress(bench.rate);
        console.log(`[bench] step ${bench.step}  alive ${horde.stats.alive}  ${fps.toFixed(1)} fps  frame ${msAvg.toFixed(2)}ms  compute ${computeMs?.toFixed(2) ?? '?'}ms`);
      }
    } else {
      waves.update(dt);
    }
    build.update(dt, state.time);
    horde.update(dt, state.time);

    state.gold += horde.takeGold();
    const leaked = horde.takeLeaks();
    if (leaked && !BENCH && !state.sandbox) {
      state.hp -= leaked;
      if (state.hp <= 0 && !state.over) {
        state.over = true;
        hud.gameOver(`wave ${waves.wave} - ${horde.stats.kills.toLocaleString()} orcs killed`);
      }
    }
  }

  effects.sync(build.turrets, build.segments, build.blasts, state.time);
  const b = BUILDS[state.selected];
  effects.setGhost(pointer.world, b, pointer.world ? build.valid(pointer.world, b) : false);

  renderer.render(scene, camera);

  // GPU timings, resolved off the frame path. Not every device exposes
  // timestamp-query, hence the shrug.
  if (frames % 12 === 0) {
    renderer.resolveTimestampsAsync(THREE.TimestampQuery.COMPUTE)
      .then(() => { computeMs = renderer.info.compute.timestamp ?? null; }).catch(() => {});
    renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER)
      .then(() => { renderMs = renderer.info.render.timestamp ?? null; }).catch(() => {});
  }

  hud.update({
    hp: state.hp, hpMax: state.hpMax, gold: state.gold,
    alive: horde.stats.alive, kills: horde.stats.kills,
    wave: waves.wave, mapName: `${field.name}${BENCH ? '  [BENCH]' : ''}`,
    waveText: waveText(),
    fps, ms: msAvg, computeMs, renderMs,
    spawned: horde.stats.spawned, cap: MAX_ORCS, selected: state.selected,
    recycling: horde.stats.recycling === true,
  });
}

function waveText() {
  if (state.sandbox && !BENCH) return 'SANDBOX (G to arm base)';
  if (BENCH) return `ramp step ${bench.step}`;
  if (state.paused) return 'paused';
  if (waves.state === 'running') return `${waves.remaining} left to spawn`;
  if (waves.state === 'breather') return `next in ${waves.timer.toFixed(1)}s (SPACE to rush)`;
  return 'press SPACE to begin';
}

requestAnimationFrame(frame);
