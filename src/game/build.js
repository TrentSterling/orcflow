// Placement rules and turret behaviour. Ramparts and authored rock are the same
// thing to the sim, so a player-built maze rebakes the flow field the instant it
// lands and the horde reroutes mid-run.
//
// Turrets are CPU logic that emits flat damage shapes for the GPU:
//   blades  -> one disc
//   beam    -> one segment, locked onto the thickest crowd so it carves
//   bounce  -> one segment per reflection leg, zig-zagging off rock
//   mortar  -> blasts, which are discs with a short life

import { BUILDS, CELL_SCALE, RAMPART, RAMPART_HP, CHEW_DPS, TURRET_SIZE, BLAST_LIFE, MAX_BLASTS, MAX_TURRETS, MAX_BUILT, NO_BUILD_RADIUS, ABILITIES, SELL_REFUND } from '../config.js';

let nextId = 1;
const BUILDS_WALL_COST = BUILDS.find((b) => b.kind === 'wall').cost;

const shortestTurn = (from, to) => {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

export class Build {
  constructor(field, ground, horde, onFieldChange = () => {}, maxBuilt = MAX_BUILT) {
    this.maxBuilt = maxBuilt;
    this.onFieldChange = onFieldChange;
    this.onRampartLost = null;
    this.ramparts = [];
    this.chewTimer = 0;
    this.field = field;
    this.ground = ground;
    this.horde = horde;
    this.turrets = [];
    this.blasts = [];
    this.segments = [];        // what Effects draws
    this.counts = {};          // per-build purchases, for price escalation
    this.cooldowns = Object.fromEntries(ABILITIES.map((a) => [a.id, 0]));
  }

  reset() {
    this.ramparts.length = 0;
    this.turrets.length = 0;
    this.blasts.length = 0;
    this.segments.length = 0;
    this.counts = {};
    for (const id in this.cooldowns) this.cooldowns[id] = 0;
  }

  // ---- active abilities -----------------------------------------------------
  abilityReady(a) { return (this.cooldowns[a.id] ?? 0) <= 0; }

  fireAbility(a, at, dir = { x: 1, y: 0 }) {
    if (!this.abilityReady(a)) return false;
    this.cooldowns[a.id] = a.cooldown;
    const len = Math.hypot(dir.x, dir.y) || 1;
    const ux = dir.x / len, uy = dir.y / len;
    const first = -((a.count - 1) / 2) * a.spacing;
    for (let i = 0; i < a.count; i++) {
      if (this.blasts.length >= MAX_BLASTS) break;
      const d = first + i * a.spacing;
      this.blasts.push({
        x: at.x + ux * d, y: at.y + uy * d,
        radius: a.radius * 0.4, full: a.radius,
        dps: a.dps, life: a.life, life0: a.life, hitsPerSec: a.hitsPerSec ?? 1e6,
      });
    }
    return true;
  }

  // ---- upgrades -------------------------------------------------------------
  // Without these, player power is capped while wave demand compounds ~30% a
  // wave, so every map ends in the same wall no matter how the numbers are
  // tuned. Upgrades are how gold keeps converting into power.
  turretAt(world, r = 1.8) {
    let best = null, bestD = r;
    for (const t of this.turrets) {
      const d = Math.hypot(t.x - world.x, t.y - world.y);
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  }

  // Ramparts were unsellable: turretAt only looks at turrets, so a shift-click on
  // one did nothing at all (or worse, tried to build on it, since a rampart is
  // rock). They refund like anything else now.
  rampartAt(world) {
    const { gx, gy } = this.latticeAt(world, RAMPART);
    return this.ramparts.find((r) => r.gx === gx && r.gy === gy) ?? null;
  }

  sellRampart(r) {
    const i = this.ramparts.indexOf(r);
    if (i < 0) return 0;
    this.ramparts.splice(i, 1);
    this.field.setCells(r.gx, r.gy, RAMPART, false);
    this.field.bake();
    this.ground.rebuild();
    this.onFieldChange();
    // pro-rated by how much of the wall is still standing
    const wear = Math.max(0.15, r.hp / r.maxHp);
    return Math.round(BUILDS_WALL_COST * wear * SELL_REFUND);
  }

  upgradeCost(t) {
    return Math.round(t.baseCost * 0.8 * Math.pow(1.55, t.level - 1));
  }

  maxLevel() { return 6; }

  sell(t) {
    const i = this.turrets.indexOf(t);
    if (i < 0) return 0;
    this.turrets.splice(i, 1);
    return Math.round((t.spent ?? t.baseCost) * SELL_REFUND);
  }

  upgrade(t) {
    if (t.level >= this.maxLevel()) return 'max level';
    t.spent = (t.spent ?? t.baseCost) + this.upgradeCost(t);
    t.level++;
    t.dps *= 1.6;
    t.hitsPerSec *= 1.5;
    t.range *= 1.05;
    if (t.blast) t.blast *= 1.06;
    return null;
  }

  // Every copy of a build costs more than the last. Without this the player just
  // carpets the map and placement stops being a decision: the baseline bot won
  // 20 waves untouched with 300 turrets.
  costOf(build) {
    const n = this.counts[build.id] ?? 0;
    return Math.round(build.cost * Math.pow(build.escalate ?? 1.13, n));
  }

  // Ramparts snap to a RAMPART-sized lattice of sim cells.
  // Ramparts and turrets each snap to their own lattice of sim cells.
  latticeAt(world, size) {
    return {
      gx: Math.floor(world.x / size) * size,
      gy: Math.floor(world.y / size) * size,
    };
  }

  snap(world, build) {
    const size = build.kind === 'wall' ? RAMPART : TURRET_SIZE;
    const { gx, gy } = this.latticeAt(world, size);
    return { x: gx + size / 2, y: gy + size / 2 };
  }

  atCap() { return this.turrets.length >= this.maxBuilt; }

  builtOf(id) { return this.turrets.reduce((n, t) => n + (t.buildId === id ? 1 : 0), 0); }
  limitOf(def) { return def.limit ?? 99; }
  atTypeCap(def) { return def.kind === 'turret' && this.builtOf(def.id) >= this.limitOf(def); }

  nearPortal(c) {
    return this.field.spawns.some((s) => Math.hypot(s.x - c.x, s.y - c.y) < NO_BUILD_RADIUS);
  }

  valid(world, build) {
    const c = this.snap(world, build);
    if (this.nearPortal(c)) return false;
    if (build.kind === 'wall') {
      const { gx, gy } = this.latticeAt(world, RAMPART);
      if (!this.field.canBuildCells(gx, gy, RAMPART)) return false;
      return !this.turrets.some((t) => Math.abs(t.x - c.x) < 2 && Math.abs(t.y - c.y) < 2);
    }
    if (this.atCap() || this.atTypeCap(build)) return false;
    const { gx, gy } = this.latticeAt(world, TURRET_SIZE);
    if (!this.field.isPlatform(gx, gy, TURRET_SIZE)) return false;   // turrets sit on rock
    return !this.turrets.some((t) => Math.hypot(t.x - c.x, t.y - c.y) < 2.4);
  }

  // Returns null on success or a short reason to show the player.
  place(world, build) {
    if (this.nearPortal(this.snap(world, build))) return 'too close to the portal';
    if (build.kind !== 'wall') {
      const { gx, gy } = this.latticeAt(world, TURRET_SIZE);
      if (!this.field.isPlatform(gx, gy, TURRET_SIZE)) return 'turrets are built on the rock';
      if (this.atTypeCap(build)) return `all ${this.limitOf(build)} ${build.name} slots used`;
      if (this.atCap()) return 'out of turret slots';
    }
    if (!this.valid(world, build)) return 'blocked';
    const c = this.snap(world, build);

    if (build.kind === 'wall') {
      const { gx, gy } = this.latticeAt(world, RAMPART);
      this.field.setCells(gx, gy, RAMPART, true);
      this.field.bake();
      if (!this.field.reachable()) {
        this.field.setCells(gx, gy, RAMPART, false);
        this.field.bake();
        return 'that would seal the path';
      }
      this.ramparts.push({ gx, gy, hp: RAMPART_HP, maxHp: RAMPART_HP });
      this.ground.rebuild();
      this.counts[build.id] = (this.counts[build.id] ?? 0) + 1;
      return null;
    }

    this.turrets.push({
      id: nextId++,
      level: 1,
      buildId: build.id,
      baseCost: build.cost,
      spent: this.costOf(build),
      x: c.x, y: c.y,
      type: build.type,
      range: build.range,
      dps: build.dps,
      width: build.width ?? 1,
      sweep: build.sweep ?? 0,
      dwell: build.dwell ?? 1.2,
      hitsPerSec: build.hitsPerSec ?? 1e6,
      damage: build.damage ?? 0,
      rpm: build.rpm ?? 0,
      spread: build.spread ?? 0.1,
      carry: 0,
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

  // Orcs pressed against a rampart chew it down. The crowd count comes straight
  // from the density snapshot the GPU already hands back, so this costs nothing.
  #chewRamparts(dt) {
    if (!this.ramparts.length) return;
    let broke = false;
    for (let i = this.ramparts.length - 1; i >= 0; i--) {
      const r = this.ramparts[i];
      const crowd = this.horde.crowdAround(r.gx + RAMPART / 2, r.gy + RAMPART / 2, 2.5);
      if (crowd <= 0) continue;
      r.hp -= crowd * CHEW_DPS * dt;
      if (r.hp > 0) continue;
      this.field.setCells(r.gx, r.gy, RAMPART, false);
      this.ramparts.splice(i, 1);
      broke = true;
    }
    if (broke) {
      this.field.bake();
      this.ground.rebuild();
      this.onFieldChange();
      this.onRampartLost?.();
    }
  }

  // Machine guns: aim at the thickest crowd in range and emit rounds. Fractional
  // rounds carry over so a 660 rpm gun is 11 a second, not 10 or 12.
  #muzzles(dt) {
    const out = [];
    let damage = 0, spread = 0.1;
    for (const t of this.turrets) {
      if (t.type !== 4) continue;
      const target = this.horde.densestNear(t.x, t.y, t.range);
      if (target) t.angle = Math.atan2(target.y - t.y, target.x - t.x);
      else { t.angle += 1.1 * dt; t.carry = 0; continue; }
      t.carry += (t.rpm / 60) * dt;
      const rounds = Math.floor(t.carry);
      t.carry -= rounds;
      damage = t.damage;
      spread = t.spread;
      if (rounds > 0 && out.length < 16) out.push({ x: t.x, y: t.y, angle: t.angle, rounds });
    }
    this.horde.setMuzzles(out, damage, spread);
  }

  update(dt, time) {
    for (const id in this.cooldowns) this.cooldowns[id] = Math.max(0, this.cooldowns[id] - dt);
    this.chewTimer -= dt;
    if (this.chewTimer <= 0) {
      this.#chewRamparts(0.25);
      this.chewTimer = 0.25;
    }
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

      if (t.type === 4) continue;      // projectiles, handled by #muzzles

      if (t.type === 3) {
        t.timer -= dt;
        if (t.timer <= 0) {
          // Aim at the thickest part of the horde using the async density
          // snapshot. The CPU never learns about individual orcs.
          const target = this.horde.densestNear(t.x, t.y, t.range);
          if (target && this.blasts.length < MAX_BLASTS) {
            this.blasts.push({
              x: target.x, y: target.y, radius: t.blast * 0.5, full: t.blast,
              dps: t.dps, life: BLAST_LIFE, life0: BLAST_LIFE, hitsPerSec: t.hitsPerSec,
            });
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
      const k = 1 - Math.max(0, b.life) / (b.life0 ?? BLAST_LIFE);
      b.radius = b.full * (0.45 + 0.55 * k);
      if (b.life <= 0) this.blasts.splice(i, 1);
    }

    this.#muzzles(dt);
    this.horde.setWeapons(weapons);
    this.horde.setBlasts(this.blasts.map((b) => ({ ...b, cap: (b.hitsPerSec ?? 1e9) * dt })));
  }
}
