// Waves ramp headcount first and health second, because the count is the whole
// point of the game.

import { ORC_TYPES } from '../config.js';

// Build phase between waves, like the original: the wave does not start until
// the player says so. Calling it early pays a bounty, so there is a reason to
// press the button instead of idling.
const RUSH_BONUS_PER_SEC = 8;

// Headcount is the whole point, so it grows quadratically: wave 1 is about 350
// orcs, wave 10 about 8,000, wave 20 about 28,000. Health and speed scale too,
// which is what eventually beats a fixed number of turrets.
export function composition(n) {
  const entries = [
    { type: 0, count: Math.round(150 + n * 200 + n * n * 60), dur: 10 },
  ];
  if (n >= 2) entries.push({ type: 2, count: Math.round(40 + n * 30), dur: 7 });
  if (n >= 3) entries.push({ type: 1, count: Math.round(4 + n * 4), dur: 9 });
  return entries;
}

export class Waves {
  constructor(field, horde) {
    this.field = field;
    this.horde = horde;
    this.wave = 0;
    this.state = 'idle';         // idle | build | running
    this.timer = 0;
    this.active = [];
    this.portal = 0;
    this.hpScale = 1;
    this.speedScale = 1;
  }

  get remaining() {
    return this.active.reduce((a, e) => a + Math.ceil(e.count), 0);
  }

  call() {
    if (this.state === 'running') return false;
    this.wave++;
    // Multiplicative, not linear. A fixed line of turrets has a fixed damage
    // throughput, so linear health means the defence always wins eventually.
    // Compounding health is what makes late waves genuinely threatening.
    this.hpScale = Math.pow(1.17, this.wave - 1);
    this.speedScale = 1 + (this.wave - 1) * 0.035;
    this.active = composition(this.wave).map((e) => ({ ...e, acc: 0 }));
    this.state = 'running';
    return true;
  }

  // Gold for calling the next wave early, paid from the build phase you skipped.
  rushBonus() {
    return this.state === 'build' ? Math.round(Math.max(0, this.timer) * RUSH_BONUS_PER_SEC) : 0;
  }

  update(dt) {
    if (this.state === 'build') {
      this.timer -= dt;                 // counts down for the rush bonus only
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
        speed: t.speed * this.speedScale,
        gold: t.gold,
        scale: t.scale,
        spread: 1.7,
      });
    }

    if (this.active.every((e) => e.count <= 0)) {
      this.state = 'build';
      this.timer = 20;                  // full rush bonus if called immediately
    }
  }
}
