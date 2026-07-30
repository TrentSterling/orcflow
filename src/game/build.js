// Placement rules and turret behaviour. Ramparts and authored rock are the same
// thing to the sim, so a player-built maze rebakes the flow field the instant it
// lands and the horde reroutes mid-run.
//
// Turrets are CPU logic that emits flat damage shapes for the GPU:
//   blades  -> one disc
//   beam    -> one segment, locked onto the thickest crowd so it carves
//   bounce  -> one segment per reflection leg, zig-zagging off rock
//   mortar  -> blasts, which are discs with a short life

import { CELL_SCALE, RAMPART, BLAST_LIFE, MAX_BLASTS, MAX_TURRETS, MAX_BUILT } from '../config.js';

let nextId = 1;

const shortestTurn = (from, to) => {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

export class Build {
  constructor(field, ground, horde, maxBuilt = MAX_BUILT) {
    this.maxBuilt = maxBuilt;
    this.field = field;
    this.ground = ground;
    this.horde = horde;
    this.turrets = [];
    this.blasts = [];
    this.segments = [];        // what Effects draws
    this.counts = {};          // per-build purchases, for price escalation
  }

  // Every copy of a build costs more than the last. Without this the player just
  // carpets the map and placement stops being a decision: the baseline bot won
  // 20 waves untouched with 300 turrets.
  costOf(build) {
    const n = this.counts[build.id] ?? 0;
    return Math.round(build.cost * Math.pow(build.escalate ?? 1.17, n));
  }

  // Ramparts snap to a RAMPART-sized lattice of sim cells.
  rampartAt(world) {
    return {
      gx: Math.floor(world.x / RAMPART) * RAMPART,
      gy: Math.floor(world.y / RAMPART) * RAMPART,
    };
  }

  snap(world, build) {
    if (build.kind === 'wall') {
      const { gx, gy } = this.rampartAt(world);
      return { x: gx + RAMPART / 2, y: gy + RAMPART / 2 };
    }
    return { x: Math.round(world.x - 0.5) + 0.5, y: Math.round(world.y - 0.5) + 0.5 };
  }

  atCap() { return this.turrets.length >= this.maxBuilt; }

  valid(world, build) {
    if (build.kind !== 'wall' && this.atCap()) return false;
    if (build.kind === 'wall') {
      const { gx, gy } = this.rampartAt(world);
      if (!this.field.canBuildCells(gx, gy, RAMPART)) return false;
      const c = this.snap(world, build);
      return !this.turrets.some((t) => Math.abs(t.x - c.x) < 2 && Math.abs(t.y - c.y) < 2);
    }
    const c = this.snap(world, build);
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        if (this.field.isWall(Math.floor(c.x) + ox, Math.floor(c.y) + oy)) return false;
      }
    }
    if (this.turrets.some((t) => Math.hypot(t.x - c.x, t.y - c.y) < 2.4)) return false;
    const b = this.field.base;
    return Math.hypot(b.x - c.x, b.y - c.y) > 2.5;
  }

  // Returns null on success or a short reason to show the player.
  place(world, build) {
    if (build.kind !== 'wall' && this.atCap()) return `turret limit reached (${this.maxBuilt})`;
    if (!this.valid(world, build)) return 'blocked';
    const c = this.snap(world, build);

    if (build.kind === 'wall') {
      const { gx, gy } = this.rampartAt(world);
      this.field.setCells(gx, gy, RAMPART, true);
      this.field.bake();
      if (!this.field.reachable()) {
        this.field.setCells(gx, gy, RAMPART, false);
        this.field.bake();
        return 'that would seal the path';
      }
      this.ground.rebuild();
      this.counts[build.id] = (this.counts[build.id] ?? 0) + 1;
      return null;
    }

    this.turrets.push({
      id: nextId++,
      x: c.x, y: c.y,
      type: build.type,
      range: build.range,
      dps: build.dps,
      width: build.width ?? 1,
      sweep: build.sweep ?? 0,
      dwell: build.dwell ?? 1.2,
      hitsPerSec: build.hitsPerSec ?? 1e6,
      bounces: build.bounces ?? 0,
      blast: build.blast ?? 0,
      cooldown: build.cooldown ?? 1,
      timer: 0,
      target: null,
      angle: Math.random() * Math.PI * 2,
    });
    this.counts[build.id] = (this.counts[build.id] ?? 0) + 1;
    return null;
  }

  // Zig-zag: march, reflect off the face that was crossed, repeat until the
  // length budget runs out. Cheap enough to redo every frame for a few turrets.
  #bounceLegs(t) {
    const legs = [];
    let px = t.x, py = t.y;
    let dx = Math.cos(t.angle), dy = Math.sin(t.angle);
    let left = t.range;
    for (let i = 0; i <= t.bounces && left > 0.5; i++) {
      const hit = this.field.rayHit(px, py, dx, dy, left);
      legs.push({ x0: px, y0: py, x1: hit.x, y1: hit.y });
      left -= Math.max(hit.dist, 0.5);
      if (!hit.axis) break;
      if (hit.axis === 'x') dx = -dx; else dy = -dy;
      px = hit.x + dx * 0.05;
      py = hit.y + dy * 0.05;
    }
    return legs;
  }

  update(dt, time) {
    const weapons = [];
    this.segments.length = 0;

    for (const t of this.turrets) {
      if (t.type === 0) {
        weapons.push({ kind: 0, x0: t.x, y0: t.y, dps: t.dps, radius: t.range, cap: t.hitsPerSec * dt });
        continue;
      }

      if (t.type === 1) {
        // Hold on one spot long enough to actually cut a hole in the crowd,
        // then pick the next thickest cluster.
        t.timer -= dt;
        if (t.timer <= 0) {
          const target = this.horde.densestNear(t.x, t.y, t.range);
          if (target) { t.target = target; t.timer = t.dwell; }
          else { t.target = null; t.timer = 0.3; }
        }
        if (t.target) {
          const want = Math.atan2(t.target.y - t.y, t.target.x - t.x);
          t.angle += shortestTurn(t.angle, want) * Math.min(1, dt * 7);
        } else {
          t.angle += 0.7 * dt;      // idle scan
        }
        const hit = this.field.rayHit(t.x, t.y, Math.cos(t.angle), Math.sin(t.angle), t.range);
        weapons.push({ kind: 1, x0: t.x, y0: t.y, x1: hit.x, y1: hit.y, dps: t.dps, width: t.width, cap: t.hitsPerSec * dt });
        this.segments.push({ x0: t.x, y0: t.y, x1: hit.x, y1: hit.y, width: t.width, hot: 1 });
        continue;
      }

      if (t.type === 2) {
        t.angle += t.sweep * dt;
        const bounceLegs = this.#bounceLegs(t);
        const legs = bounceLegs.length;
        for (const leg of bounceLegs) {
          if (weapons.length >= MAX_TURRETS) break;
          weapons.push({ kind: 1, ...leg, dps: t.dps, width: t.width, cap: (t.hitsPerSec / Math.max(1, legs)) * dt });
          this.segments.push({ ...leg, width: t.width, hot: 0.75 });
        }
        continue;
      }

      if (t.type === 3) {
        t.timer -= dt;
        if (t.timer <= 0) {
          // Aim at the thickest part of the horde using the async density
          // snapshot. The CPU never learns about individual orcs.
          const target = this.horde.densestNear(t.x, t.y, t.range);
          if (target && this.blasts.length < MAX_BLASTS) {
            this.blasts.push({ x: target.x, y: target.y, radius: t.blast * 0.5, full: t.blast, dps: t.dps, life: BLAST_LIFE });
            t.timer = t.cooldown;
          } else {
            t.timer = 0.25;         // nothing worth shelling, check again shortly
          }
        }
      }
    }

    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const b = this.blasts[i];
      b.life -= dt;
      const k = 1 - Math.max(0, b.life) / BLAST_LIFE;
      b.radius = b.full * (0.45 + 0.55 * k);
      if (b.life <= 0) this.blasts.splice(i, 1);
    }

    this.horde.setWeapons(weapons);
    this.horde.setBlasts(this.blasts);
  }
}
