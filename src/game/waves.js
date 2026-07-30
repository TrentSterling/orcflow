// Waves ramp headcount first and health second, because the count is the whole
// point of the game.

import { ORC_TYPES } from '../config.js';

const BREATHER = 8;

export function composition(n) {
  const entries = [
    { type: 0, count: Math.round(30 + n * 26 + n * n * 2.5), dur: 14 },
  ];
  if (n >= 2) entries.push({ type: 2, count: Math.round(10 + n * 8), dur: 10 });
  if (n >= 3) entries.push({ type: 1, count: Math.round(2 + n * 1.6), dur: 12 });
  return entries;
}

export class Waves {
  constructor(field, horde) {
    this.field = field;
    this.horde = horde;
    this.wave = 0;
    this.state = 'idle';         // idle | running | breather
    this.timer = 0;
    this.active = [];
    this.portal = 0;
    this.hpScale = 1;
  }

  get remaining() {
    return this.active.reduce((a, e) => a + Math.ceil(e.count), 0);
  }

  call() {
    if (this.state === 'running') return false;
    this.wave++;
    this.hpScale = 1 + (this.wave - 1) * 0.2;
    this.active = composition(this.wave).map((e) => ({ ...e, acc: 0 }));
    this.state = 'running';
    return true;
  }

  update(dt) {
    if (this.state === 'breather') {
      this.timer -= dt;
      if (this.timer <= 0) this.call();
      return;
    }
    if (this.state !== 'running') return;

    for (const e of this.active) {
      if (e.count <= 0) continue;
      e.acc += (e.count0 ?? (e.count0 = e.count)) / e.dur * dt;
      const n = Math.min(Math.floor(e.acc), Math.ceil(e.count));
      if (n <= 0) continue;
      e.acc -= n;
      e.count -= n;
      const t = ORC_TYPES[e.type];
      const portal = this.field.spawns[this.portal++ % this.field.spawns.length];
      this.horde.spawn(n, {
        pos: portal,
        hp: t.hp * this.hpScale,
        type: e.type,
        speed: t.speed,
        gold: t.gold,
        scale: t.scale,
        spread: 1.7,
      });
    }

    if (this.active.every((e) => e.count <= 0)) {
      this.state = 'breather';
      this.timer = BREATHER;
    }
  }
}
