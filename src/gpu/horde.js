// The horde. Every orc lives on the GPU for its whole life; the CPU only ever
// sets uniforms and reads back four counters.
//
// Passes, in dispatch order each frame:
//
//   spawn    up to SPAWN_BATCH threads, writes new orcs at a ring cursor
//   scatter  every orc atomically bumps a coarse density cell
//   sim      steer down the flow field, push out of crowds, take damage, die
//   clear    zero the density grid for next frame
//
// Nothing is read back synchronously. Kills / gold / leaks are monotonic atomic
// counters that the CPU diffs from an async snapshot, and the density grid is
// snapshotted asynchronously so mortars can aim at the thickest part of the
// horde without the CPU ever knowing an individual orc exists.

import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, instancedArray, uniform, uniformArray, atomicAdd, atomicLoad,
  atomicStore, texture, textureLoad, instanceIndex, float, int, uint, vec2, vec3,
  vec4, ivec2, length, max, min, abs, floor, mix, step, clamp, dot, sin, cos,
  hash, positionGeometry, uv,
} from 'three/tsl';

import {
  MAX_ORCS, SPAWN_BATCH, MAX_TURRETS, MAX_BLASTS, GRID_W, GRID_H,
  DENS_W, DENS_H, DENS_SCALE, CORPSE_FADE, REST_DENSITY, PRESSURE, VISCOSITY, BOUNTY_FLOOR,
  BUCKET_K, ORC_RADIUS, RESTITUTION, JAM_DENSITY, JAM_SLOWDOWN, WALL_DRAG, CURL,
  COHESION, BULLET_PIERCE_COST, BULLET_BLAST, BULLET_BLAST_MULT,
  MAX_BULLETS, MAX_MUZZLES, MUZZLE_BURST, BULLET_SPEED, BULLET_LIFE,
} from '../config.js';

export class Horde {
  constructor(renderer, flowTexture, atlasTexture, basePos) {
    this.renderer = renderer;
    this.capacity = MAX_ORCS;
    this.cursor = 0;

    // Totals the CPU believes in, updated from async readbacks.
    this.stats = { kills: 0, leaks: 0, gold: 0, spawned: 0, alive: 0, recycled: 0 };
    this._lastCounters = [0, 0, 0, 0];
    this._lastStuck = 0;
    this._countersInFlight = false;
    this._generation = 0;
    this._densityInFlight = false;
    this.density = new Uint32Array(DENS_W * DENS_H);
    // density summed per world cell: what the turret AI actually queries
    this.coarse = new Uint32Array(GRID_W * GRID_H);
    this.pendingLeaks = 0;
    this.pendingGold = 0;

    // ---- buffers -----------------------------------------------------------
    // pos: x, y, vx, vy
    // dat: hp, type, seed, deathTime      (deathTime 0 = still alive)
    // att: maxSpeed, goldValue, lastHitTime, scale
    const pos = instancedArray(MAX_ORCS, 'vec4');
    const dat = instancedArray(MAX_ORCS, 'vec4');
    const att = instancedArray(MAX_ORCS, 'vec4');
    const dens = instancedArray(DENS_W * DENS_H, 'uint').toAtomic();
    // Four sums per cell: velocity x, velocity y, position x, position y. Velocity
    // carries a +1000 bias per orc so the atomics stay unsigned; position is
    // always positive so it just gets scaled. Averaging these gives the two boid
    // rules that need a neighbourhood, alignment and cohesion. All four live in
    // one buffer because WebGPU only guarantees 8 storage buffers a stage.
    const densV = instancedArray(DENS_W * DENS_H * 4, 'uint').toAtomic();
    // Spatial hash: up to BUCKET_K orc indices per cell, written as index+1 so
    // zero means empty. Not atomic, only the counter is.
    const bucket = instancedArray(DENS_W * DENS_H * BUCKET_K, 'uint');
    // One vec4 per bullet: x, y, angle, life. Speed and damage are uniforms, which
    // is what keeps projectiles inside the 8-storage-buffer budget.
    const bullets = instancedArray(MAX_BULLETS, 'vec4');
    // One buffer for every counter: kills, leaks, gold, spare, then a per-weapon
    // hit budget refilled each frame (weapons first, blasts after them). Without
    // that budget, area damage grows with crowd density and a bigger horde just
    // feeds the turrets.
    const CNT_BUDGET = 6;   // 0-3 monotonic, 4 stuck gauge, 5 spare
    const cnt = instancedArray(CNT_BUDGET + MAX_TURRETS + MAX_BLASTS, 'uint').toAtomic();
    const budgetAt = (i) => i.add(int(CNT_BUDGET));
    this._buffers = { pos, dat, att, dens, densV, bucket, bullets, cnt };

    // ---- uniforms ----------------------------------------------------------
    const u = {
      dt: uniform(0),
      time: uniform(1),               // starts at 1 so "deathTime 0" means alive
      pressure: uniform(PRESSURE),
      viscosity: uniform(VISCOSITY),
      cohesion: uniform(COHESION),
      basePos: uniform(new THREE.Vector2(basePos.x, basePos.y)),
      turretCount: uniform(0, 'int'),
      blastCount: uniform(0, 'int'),
      spawnCount: uniform(0, 'int'),
      spawnCursor: uniform(0, 'int'),
      spawnPos: uniform(new THREE.Vector2()),
      spawnSpread: uniform(1.6),
      spawnHp: uniform(10),
      spawnType: uniform(0),
      spawnSpeed: uniform(4),
      spawnGold: uniform(1),
      spawnScale: uniform(0.6),
      spawnSeed: uniform(0, 'int'),
      bulletCursor: uniform(0, 'int'),
      bulletDamage: uniform(25),
      bulletSpread: uniform(0.1),
      muzzleCount: uniform(0, 'int'),
    };
    this.u = u;

    this.turretA = uniformArray(Array.from({ length: MAX_TURRETS }, () => new THREE.Vector4()), 'vec4');
    this.turretB = uniformArray(Array.from({ length: MAX_TURRETS }, () => new THREE.Vector4()), 'vec4');
    // x = how many orcs this weapon may damage this frame
    this.turretC = uniformArray(Array.from({ length: MAX_TURRETS }, () => new THREE.Vector4()), 'vec4');
    this.blastArr = uniformArray(Array.from({ length: MAX_BLASTS }, () => new THREE.Vector4()), 'vec4');
    // x = hits this blast may land this frame
    this.blastCaps = uniformArray(Array.from({ length: MAX_BLASTS }, () => new THREE.Vector4()), 'vec4');
    // x, y, angle, rounds to emit this frame
    this.muzzles = uniformArray(Array.from({ length: MAX_MUZZLES }, () => new THREE.Vector4()), 'vec4');

    // ---- shared shader helpers --------------------------------------------
    const flowTex = texture(flowTexture);
    const gw = float(GRID_W), gh = float(GRID_H);

    // Compute shaders cannot use filtered sampling, so blend four loads by hand.
    // Rock cells store a direction pointing back out into open ground, which is
    // what keeps anything that clips into geometry from sticking.
    const flowAt = (p) => {
      const fp = p.sub(vec2(0.5)).toVar();
      const b = floor(fp).toVar();
      const fr = fp.sub(b).toVar();
      const at = (ox, oy) => {
        const cx = clamp(b.x.add(float(ox)), float(0), gw.sub(1));
        const cy = clamp(b.y.add(float(oy)), float(0), gh.sub(1));
        return textureLoad(flowTex, ivec2(cx, cy)).xy.mul(2).sub(1);
      };
      const blended = mix(
        mix(at(0, 0), at(1, 0), fr.x),
        mix(at(0, 1), at(1, 1), fr.x),
        fr.y,
      ).toVar();
      // Rock cells carry escape vectors pointing out of the slab, so next to
      // geometry the blend can cancel to nothing and the orc simply stops. When
      // that happens, fall back to this cell's own unfiltered direction, which is
      // always a real heading.
      const len = length(blended).toVar();
      const raw = textureLoad(flowTex,
        ivec2(clamp(p.x, float(0), gw.sub(1)), clamp(p.y, float(0), gh.sub(1)))).xy.mul(2).sub(1);
      return mix(raw, blended.div(len), step(float(0.35), len));
    };

    // Normalised distance to base, straight out of the flow texture's alpha.
    // 1 at the portal, 0 at the base.
    const pathDist = (q) => {
      const cx = clamp(q.x, float(0), gw.sub(1));
      const cy = clamp(q.y, float(0), gh.sub(1));
      return textureLoad(flowTex, ivec2(cx, cy)).w;
    };

    // How enclosed a spot is, 0 in open ground to 1 against rock. Bilinear on the
    // rock flag, which is already in the texture.
    const wallness = (p) => {
      const fp = p.sub(vec2(0.5)).toVar();
      const b = floor(fp).toVar();
      const fr = fp.sub(b).toVar();
      const at = (ox, oy) => {
        const cx = clamp(b.x.add(float(ox)), float(0), gw.sub(1));
        const cy = clamp(b.y.add(float(oy)), float(0), gh.sub(1));
        return textureLoad(flowTex, ivec2(cx, cy)).z;
      };
      const blended = mix(
        mix(at(0, 0), at(1, 0), fr.x),
        mix(at(0, 1), at(1, 1), fr.x),
        fr.y,
      ).toVar();
      // Rock cells carry escape vectors pointing out of the slab, so next to
      // geometry the blend can cancel to nothing and the orc simply stops. When
      // that happens, fall back to this cell's own unfiltered direction, which is
      // always a real heading.
      const len = length(blended).toVar();
      const raw = textureLoad(flowTex,
        ivec2(clamp(p.x, float(0), gw.sub(1)), clamp(p.y, float(0), gh.sub(1)))).xy.mul(2).sub(1);
      return mix(raw, blended.div(len), step(float(0.35), len));
    };

    // Exact per-cell rock test, no interpolation.
    const isRock = (q) => {
      const cx = clamp(q.x, float(0), gw.sub(1));
      const cy = clamp(q.y, float(0), gh.sub(1));
      return textureLoad(flowTex, ivec2(cx, cy)).z.greaterThan(0.5);
    };

    // Crowd separation from the coarse density grid: push down the gradient of
    // "how many neighbours are over there". Cheap stand-in for pair collisions
    // and it produces the nose-to-tail river look.
    // Fluid step from the density grid: a pressure gradient plus the local mean
    // velocity. Pressure only builds past a resting density, so the crowd packs
    // shoulder to shoulder and only spreads where it is actually squeezed, and
    // the velocity term makes neighbours agree, which is what reads as flow.
    const crowdForces = (p) => {
      const cx = int(clamp(p.x.mul(DENS_SCALE), float(1), float(DENS_W - 2))).toVar();
      const cy = int(clamp(p.y.mul(DENS_SCALE), float(1), float(DENS_H - 2))).toVar();
      const push = vec2(0).toVar();
      const here = int(0).toVar();
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const idx = cy.add(int(oy)).mul(int(DENS_W)).add(cx.add(int(ox)));
          if (ox === 0 && oy === 0) { here.assign(idx); continue; }
          const n = float(atomicLoad(dens.element(idx))).toVar();
          const press = max(n.sub(float(REST_DENSITY)), float(0)).toVar();
          push.subAssign(vec2(ox, oy).mul(press));
        }
      }
      const n0 = float(atomicLoad(dens.element(here))).toVar();
      const inv = float(1).div(max(n0, float(1))).toVar();
      const sx = float(atomicLoad(densV.element(here.mul(4)))).toVar();
      const sy = float(atomicLoad(densV.element(here.mul(4).add(1)))).toVar();
      const mean = vec2(
        sx.sub(n0.mul(1000)).mul(inv).div(100),
        sy.sub(n0.mul(1000)).mul(inv).div(100),
      ).toVar();
      // centre of mass of the neighbourhood, for cohesion
      const px = float(atomicLoad(densV.element(here.mul(4).add(2)))).toVar();
      const py = float(atomicLoad(densV.element(here.mul(4).add(3)))).toVar();
      const centre = vec2(px.mul(inv).div(10), py.mul(inv).div(10)).toVar();
      return { push, mean, centre, count: n0 };
    };

    // ---- pass: init --------------------------------------------------------
    // deathTime far in the past means "empty slot", so nothing renders at boot.
    this.bulletClearPass = Fn(() => {
      bullets.element(instanceIndex).assign(vec4(0, 0, 0, 0));
    })().compute(MAX_BULLETS);

    this.initPass = Fn(() => {
      pos.element(instanceIndex).assign(vec4(0, 0, 0, 0));
      dat.element(instanceIndex).assign(vec4(0, 0, 0, -1000));
      att.element(instanceIndex).assign(vec4(1, 0, -1000, 0.5));
    })().compute(MAX_ORCS);

    // Zeroes the monotonic counters, so a restart starts from a clean score
    // without the CPU having to track an offset.
    this.counterResetPass = Fn(() => {
      atomicStore(cnt.element(instanceIndex), uint(0));
    })().compute(4);

    // ---- pass: spawn -------------------------------------------------------
    this.spawnPass = Fn(() => {
      If(int(instanceIndex).lessThan(u.spawnCount), () => {
        const slot = u.spawnCursor.add(int(instanceIndex)).mod(int(MAX_ORCS)).toVar();
        const s1 = hash(instanceIndex.add(uint(u.spawnSeed))).toVar();
        const s2 = hash(instanceIndex.add(uint(u.spawnSeed)).add(uint(9871))).toVar();
        const s3 = hash(instanceIndex.add(uint(u.spawnSeed)).add(uint(31337))).toVar();
        const off = vec2(s1.sub(0.5), s2.sub(0.5)).mul(u.spawnSpread.mul(2));
        pos.element(slot).assign(vec4(u.spawnPos.add(off), 0, 0));
        dat.element(slot).assign(vec4(u.spawnHp, u.spawnType, s3, 0));
        att.element(slot).assign(vec4(u.spawnSpeed, u.spawnGold, -1000, u.spawnScale));
      });
    })().compute(SPAWN_BATCH);

    // ---- pass: scatter -----------------------------------------------------
    this.scatterPass = Fn(() => {
      If(dat.element(instanceIndex).x.greaterThan(0), () => {
        const P = pos.element(instanceIndex).toVar();
        const p = P.xy.toVar();
        const cx = int(clamp(p.x.mul(DENS_SCALE), float(0), float(DENS_W - 1)));
        const cy = int(clamp(p.y.mul(DENS_SCALE), float(0), float(DENS_H - 1)));
        const cell = cy.mul(int(DENS_W)).add(cx).toVar();
        const slot = atomicAdd(dens.element(cell), uint(1)).toVar();
        atomicAdd(densV.element(cell.mul(4)), uint(P.z.mul(100).add(1000)));
        atomicAdd(densV.element(cell.mul(4).add(1)), uint(P.w.mul(100).add(1000)));
        atomicAdd(densV.element(cell.mul(4).add(2)), uint(p.x.mul(10)));
        atomicAdd(densV.element(cell.mul(4).add(3)), uint(p.y.mul(10)));
        // first few orcs in a cell get a bucket slot for the pairwise pass
        If(slot.lessThan(uint(BUCKET_K)), () => {
          bucket.element(cell.mul(int(BUCKET_K)).add(int(slot))).assign(instanceIndex.add(uint(1)));
        });
      });
    })().compute(MAX_ORCS);

    // True circle-circle separation against the bucket contents: bounded work,
    // no sorting, and it is what stops orcs from occupying each other. The
    // density pressure term stays for the far field, where an exact answer does
    // not matter and a gradient reads better.
    const pairSeparation = (p, self) => {
      const cx = int(clamp(p.x.mul(DENS_SCALE), float(1), float(DENS_W - 2))).toVar();
      const cy = int(clamp(p.y.mul(DENS_SCALE), float(1), float(DENS_H - 2))).toVar();
      const push = vec2(0).toVar();
      const minDist = float(ORC_RADIUS * 2);
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const cell = cy.add(int(oy)).mul(int(DENS_W)).add(cx.add(int(ox))).toVar();
          for (let k = 0; k < BUCKET_K; k++) {
            const raw = bucket.element(cell.mul(int(BUCKET_K)).add(int(k))).toVar();
            If(raw.greaterThan(uint(0)), () => {
              const other = raw.sub(uint(1)).toVar();
              If(other.notEqual(self), () => {
                const q = pos.element(other).xy.toVar();
                const d = p.sub(q).toVar();
                const dist = length(d).add(1e-4).toVar();
                If(dist.lessThan(minDist), () => {
                  push.addAssign(d.div(dist).mul(minDist.sub(dist)));
                });
              });
            });
          }
        }
      }
      return push;
    };

    // ---- pass: sim ---------------------------------------------------------
    this.simPass = Fn(() => {
      const d = dat.element(instanceIndex).toVar();

      If(d.x.greaterThan(0), () => {
        const P = pos.element(instanceIndex).toVar();
        const A = att.element(instanceIndex).toVar();
        const p = P.xy.toVar();
        const v = P.zw.toVar();
        const hp = d.x.toVar();
        const maxSpeed = A.x.toVar();

        // Steer along the field, rotated a hair per-orc so packs do not form
        // perfect single-file lines.
        const f = flowAt(p).toVar();
        const jit = d.z.sub(0.5).mul(0.4).toVar();
        const cs = cos(jit).toVar(), sn = sin(jit).toVar();
        const dir = vec2(
          f.x.mul(cs).sub(f.y.mul(sn)),
          f.x.mul(sn).add(f.y.mul(cs)),
        ).toVar();

        // ---- flow shaping: jam, drag, wander
        const localN = float(atomicLoad(dens.element(
          int(clamp(p.y.mul(DENS_SCALE), float(0), float(DENS_H - 1))).mul(int(DENS_W))
            .add(int(clamp(p.x.mul(DENS_SCALE), float(0), float(DENS_W - 1)))),
        ))).toVar();
        const jam = clamp(localN.div(float(JAM_DENSITY)), 0, 1).toVar();
        const drag = wallness(p).mul(float(WALL_DRAG)).toVar();
        maxSpeed.mulAssign(
          mix(float(1), float(JAM_SLOWDOWN), jam).mul(float(1).sub(drag)),
        );

        // Spatially coherent wander so neighbours agree and ribbons braid rather
        // than every orc jittering on its own.
        const nx0 = int(p.x.mul(0.12)).toVar();
        const ny0 = int(p.y.mul(0.12)).toVar();
        const tb = int(u.time.mul(0.7)).toVar();
        const wob = hash(uint(nx0.mul(int(73856093)).add(ny0.mul(int(19349663))).add(tb.mul(int(83492791)))))
          .sub(0.5).mul(float(CURL)).toVar();
        const wc = cos(wob).toVar(), ws = sin(wob).toVar();
        dir.assign(vec2(
          dir.x.mul(wc).sub(dir.y.mul(ws)),
          dir.x.mul(ws).add(dir.y.mul(wc)),
        ));

        const want = dir.mul(maxSpeed);
        v.addAssign(want.sub(v).mul(min(u.dt.mul(7), 1)));
        // The three boid rules, on top of flow-field goal seeking:
        //   alignment  match the neighbours' velocity
        //   cohesion   drift toward the local centre of mass
        //   separation pressure here, plus exact pairwise resolution below
        const crowd = crowdForces(p);
        v.addAssign(crowd.mean.sub(v).mul(min(u.viscosity.mul(u.dt), 1)));
        If(crowd.count.greaterThan(1.5), () => {
          const toCentre = crowd.centre.sub(p).toVar();
          const d = length(toCentre).add(1e-4).toVar();
          v.addAssign(toCentre.div(d).mul(u.cohesion.mul(u.dt).mul(min(d, float(1)))));
        });
        v.addAssign(crowd.push.mul(u.pressure.mul(u.dt)));

        const sp = length(v).add(1e-5).toVar();
        If(sp.greaterThan(maxSpeed), () => { v.mulAssign(maxSpeed.div(sp)); });

        // Hard guarantee: an orc always makes progress toward the goal. Crowd
        // terms are allowed to shape the flow, never to cancel it. Without this
        // a packed clump can settle into an equilibrium where cohesion, pressure
        // and jam-slowdown balance out and the whole blob parks itself.
        const along = dot(v, dir).toVar();
        const floorSpeed = maxSpeed.mul(0.35).toVar();
        If(along.lessThan(floorSpeed), () => {
          v.addAssign(dir.mul(floorSpeed.sub(along)));
        });

        // Integrate, rejecting each axis separately so orcs slide along rock
        // instead of stopping dead against it. An orc that is already buried
        // (a rampart landed on it) skips the check entirely, otherwise it can
        // never walk back out along the escape field.
        const nx = p.x.add(v.x.mul(u.dt)).toVar();
        const ny = p.y.add(v.y.mul(u.dt)).toVar();
        If(isRock(p), () => {
          // buried: follow the escape direction freely
        }).Else(() => {
          If(isRock(vec2(nx, p.y)), () => { nx.assign(p.x); v.x.mulAssign(-0.2); });
          If(isRock(vec2(p.x, ny)), () => { ny.assign(p.y); v.y.mulAssign(-0.2); });
        });
        p.assign(vec2(nx, ny));

        // Positional separation after integrating: resolving overlap directly is
        // far more stable than doing it with forces, and it is what makes a packed
        // crowd look packed instead of soupy. It must not shove anyone into rock,
        // though: an orc pushed inside a platform ends up stranded.
        const sep = pairSeparation(p, instanceIndex).mul(float(RESTITUTION)).toVar();
        const sepTo = p.add(sep).toVar();
        If(isRock(sepTo).not(), () => { p.assign(sepTo); });

        // ---- weapons. Two shapes only, both area based, which is what lets
        // damage be evaluated orc-side with no target-selection pass:
        //   kind 0  disc   centre A.xy, radius B.w
        //   kind 1  segment A.xy -> B.xy, half-width B.z
        // A bouncing beam is just several segments in a row, so the shader
        // needs no idea that reflection exists.
        const dmg = float(0).toVar();
        const touched = float(0).toVar();
        Loop(u.turretCount, ({ i }) => {
          const A = this.turretA.element(i).toVar();   // x0, y0, kind, dps
          const B = this.turretB.element(i).toVar();   // x1, y1, halfWidth, radius
          const inside = float(0).toVar();
          If(A.z.lessThan(0.5), () => {
            If(length(p.sub(A.xy)).lessThan(B.w), () => { inside.assign(1); });
          }).Else(() => {
            const ab = B.xy.sub(A.xy).toVar();
            const t = clamp(dot(p.sub(A.xy), ab).div(dot(ab, ab).add(1e-4)), 0, 1).toVar();
            const close = A.xy.add(ab.mul(t)).toVar();
            If(length(p.sub(close)).lessThan(B.z), () => { inside.assign(1); });
          });
          // Everything the shape touches flashes; only what fits the budget takes
          // damage. Tying the flash to the damage meant a beam over a thousand orcs
          // lit up the four it happened to hit that frame, which read as the beam
          // doing nothing at all.
          If(inside.greaterThan(0.5), () => {
            touched.assign(1);
            const slot = atomicAdd(cnt.element(budgetAt(i)), uint(1));
            If(float(slot).lessThan(this.turretC.element(i).x), () => { dmg.addAssign(A.w); });
          });
        });
        Loop(u.blastCount, ({ i }) => {
          const B = this.blastArr.element(i).toVar();  // x, y, radius, dps
          If(length(p.sub(B.xy)).lessThan(B.z), () => {
            touched.assign(1);
            const slot = atomicAdd(cnt.element(budgetAt(i.add(int(MAX_TURRETS)))), uint(1));
            If(float(slot).lessThan(this.blastCaps.element(i).x), () => { dmg.addAssign(B.w); });
          });
        });
        If(dmg.greaterThan(0), () => { hp.subAssign(dmg.mul(u.dt)); });
        If(touched.greaterThan(0.5), () => { A.z.assign(u.time); });   // flash

        // ---- reached the base: counts as a leak, not a kill
        // Two tests on purpose. The distance one is precise; the field one cannot
        // desync from the map, because it reads the same bake the orc is walking
        // down. A stale base uniform used to leave orcs jiggling on top of the
        // base forever: never leaking, never counted, only dying if a weapon
        // happened to cover that exact spot.
        const atBase = length(p.sub(u.basePos)).lessThan(1.7)
          .or(pathDist(p).lessThan(0.004));
        If(atBase, () => {
          hp.assign(-1);
          d.w.assign(u.time);
          atomicAdd(cnt.element(1), uint(1));
        });

        // Monotonic count of orc-frames spent inside rock. Goal-ward speed is
        // guaranteed below, so "moving too slowly" is no longer possible and
        // measuring it would be tautological; being buried in a platform still
        // is possible, and it is the failure mode worth watching. The CPU diffs
        // this like kills, because clearing it each frame raced the readback.
        If(isRock(p), () => { atomicAdd(cnt.element(4), uint(1)); });

        d.x.assign(max(hp, 0));
        att.element(instanceIndex).assign(A);
        pos.element(instanceIndex).assign(vec4(p, v));
      });

      // Death accounting sits OUTSIDE the alive branch on purpose. Bullets write
      // health directly, so an orc can arrive here already at zero without the
      // block above ever running; when the check lived inside it, those orcs
      // vanished silently with no kill, no bounty and no corpse.
      If(d.x.lessThanEqual(0).and(d.w.equal(0)), () => {
        d.w.assign(u.time);
        atomicAdd(cnt.element(0), uint(1));
        // Bounty by progress: killed leaving the portal pays a fraction, killed
        // at the gate pays in full.
        const here = pos.element(instanceIndex).xy.toVar();
        const progress = float(1).sub(pathDist(here)).toVar();
        const worth = att.element(instanceIndex).y
          .mul(float(BOUNTY_FLOOR).add(progress.mul(1 - BOUNTY_FLOOR)));
        atomicAdd(cnt.element(2), uint(max(worth, 1)));
      });
      dat.element(instanceIndex).assign(d);
    })().compute(MAX_ORCS);

    // ---- pass: bullet spawn ------------------------------------------------
    // Thread t maps to muzzle t/BURST, round t%BURST. Bounded, and the ring
    // cursor means no free-list bookkeeping.
    this.bulletSpawnPass = Fn(() => {
      const t = int(instanceIndex).toVar();
      const m = t.div(int(MUZZLE_BURST)).toVar();
      const k = t.mod(int(MUZZLE_BURST)).toVar();
      If(m.lessThan(u.muzzleCount), () => {
        const M = this.muzzles.element(m).toVar();       // x, y, angle, rounds
        If(float(k).lessThan(M.w), () => {
          const slot = u.bulletCursor.add(t).mod(int(MAX_BULLETS)).toVar();
          const r1 = hash(instanceIndex.add(uint(u.spawnSeed))).sub(0.5).toVar();
          const jitter = r1.mul(u.bulletSpread);
          // start at the muzzle, clear of the platform the gun stands on
          const aim = M.z.add(jitter).toVar();
          const muzzle = M.xy.add(vec2(cos(aim), sin(aim)).mul(1.7)).toVar();
          bullets.element(slot).assign(vec4(muzzle, aim, float(BULLET_LIFE)));
        });
      });
    })().compute(MAX_MUZZLES * MUZZLE_BURST);

    // ---- pass: bullets ----------------------------------------------------
    // Each round steps forward, samples four points along its path so it cannot
    // tunnel through a crowd, and dies on the first orc it touches. Damage is
    // written straight into the orc's health; the sim pass notices the death on
    // its next tick and does the counting.
    this.bulletPass = Fn(() => {
      const B = bullets.element(instanceIndex).toVar();
      If(B.w.greaterThan(0), () => {
        const dir = vec2(cos(B.z), sin(B.z)).toVar();
        const p0 = B.xy.toVar();
        const p1 = p0.add(dir.mul(float(BULLET_SPEED).mul(u.dt))).toVar();
        const life = B.w.sub(u.dt).toVar();

        // Guns stand on rock, so a round is born inside solid geometry. Comparing
        // both ends means it only dies on rock it has actually flown into: while
        // still inside its own platform, p0 is rock and nothing happens. No extra
        // per-bullet state needed, which matters when a bullet is one vec4.
        If(isRock(p0).not().and(isRock(p1)), () => { life.assign(0); });

        const hit = float(0).toVar();
        for (let step = 0; step < 4; step++) {
          const sp = mix(p0, p1, float((step + 0.5) / 4)).toVar();
          const cx = int(clamp(sp.x.mul(DENS_SCALE), float(0), float(DENS_W - 1))).toVar();
          const cy = int(clamp(sp.y.mul(DENS_SCALE), float(0), float(DENS_H - 1))).toVar();
          const cell = cy.mul(int(DENS_W)).add(cx).toVar();
          for (let k = 0; k < BUCKET_K; k++) {
            const raw = bucket.element(cell.mul(int(BUCKET_K)).add(int(k))).toVar();
            If(hit.lessThan(0.5).and(raw.greaterThan(uint(0))), () => {
              const other = raw.sub(uint(1)).toVar();
              const target = dat.element(other).toVar();
              If(target.x.greaterThan(0), () => {
                const q = pos.element(other).xy.toVar();
                If(length(sp.sub(q)).lessThan(float(ORC_RADIUS * 2.2)), () => {
                  // Read, modify, write the whole vec4: assigning a single
                  // component straight into a storage element does not generate a
                  // write, which is why the first version of this did no damage.
                  target.x.assign(max(target.x.sub(u.bulletDamage), float(0)));
                  dat.element(other).assign(target);
                  const A2 = att.element(other).toVar();
                  A2.z.assign(u.time);                      // hit flash
                  att.element(other).assign(A2);
                  // Pierce: a hit costs life rather than ending the round, so the
                  // pierce budget and the range are the same number.
                  life.subAssign(float(BULLET_PIERCE_COST));
                  hit.assign(1);
                  atomicAdd(cnt.element(3), uint(1));       // bullet hits, for the HUD
                });
              });
            });
          }
        }

        // End of life is a detonation, so every round is two weapons: a line of
        // pierced orcs and a blast where it stops.
        If(life.lessThanEqual(0), () => {
          const r = float(BULLET_BLAST);
          const blastDmg = u.bulletDamage.mul(float(BULLET_BLAST_MULT));
          const bcx = int(clamp(p1.x.mul(DENS_SCALE), float(2), float(DENS_W - 3))).toVar();
          const bcy = int(clamp(p1.y.mul(DENS_SCALE), float(2), float(DENS_H - 3))).toVar();
          for (let oy = -2; oy <= 2; oy++) {
            for (let ox = -2; ox <= 2; ox++) {
              const cell = bcy.add(int(oy)).mul(int(DENS_W)).add(bcx.add(int(ox))).toVar();
              for (let k = 0; k < BUCKET_K; k++) {
                const raw = bucket.element(cell.mul(int(BUCKET_K)).add(int(k))).toVar();
                If(raw.greaterThan(uint(0)), () => {
                  const idx = raw.sub(uint(1)).toVar();
                  const tv = dat.element(idx).toVar();
                  If(tv.x.greaterThan(0), () => {
                    If(length(pos.element(idx).xy.sub(p1)).lessThan(r), () => {
                      tv.x.assign(max(tv.x.sub(blastDmg), float(0)));
                      dat.element(idx).assign(tv);
                      const A3 = att.element(idx).toVar();
                      A3.z.assign(u.time);
                      att.element(idx).assign(A3);
                    });
                  });
                });
              }
            }
          }
        });
        bullets.element(instanceIndex).assign(vec4(p1, B.z, max(life, float(0))));
      });
    })().compute(MAX_BULLETS);

    // ---- pass: clear density ----------------------------------------------
    this.clearPass = Fn(() => {
      atomicStore(dens.element(instanceIndex), uint(0));
      atomicStore(densV.element(instanceIndex.mul(4)), uint(0));
      atomicStore(densV.element(instanceIndex.mul(4).add(1)), uint(0));
      atomicStore(densV.element(instanceIndex.mul(4).add(2)), uint(0));
      atomicStore(densV.element(instanceIndex.mul(4).add(3)), uint(0));
      If(instanceIndex.lessThan(uint(MAX_TURRETS + MAX_BLASTS)), () => {
        atomicStore(cnt.element(instanceIndex.add(uint(CNT_BUDGET))), uint(0));
      });

    })().compute(DENS_W * DENS_H);

    // ---- render ------------------------------------------------------------
    // Plain Mesh + InstancedBufferGeometry rather than InstancedMesh: an
    // InstancedMesh would multiply positionLocal by its (default zeroed)
    // instanceMatrix and collapse everything to the origin.
    const src = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', src.getAttribute('position'));
    geo.setAttribute('uv', src.getAttribute('uv'));
    geo.setIndex(src.getIndex());
    geo.instanceCount = MAX_ORCS;

    const posA = pos.toAttribute();
    const datA = dat.toAttribute();
    const attA = att.toAttribute();

    const aliveF = step(0.001, datA.x);
    const age = u.time.sub(datA.w);
    // Hold the splat at full strength almost all its life and fade only in the
    // last fifth, so a battlefield stays covered instead of dissolving.
    const fade = clamp(float(CORPSE_FADE).sub(age).div(float(CORPSE_FADE * 0.2)), 0, 1);
    // Fresh blood dries to dark maroon in a couple of seconds, then stays put.
    const wet = clamp(float(1).sub(age.div(2.5)), 0, 1);
    // The instant of death is white hot, which is what makes a beam sweeping a
    // crowd read as shredding rather than as a light show.
    const spark = clamp(float(1).sub(age.mul(9)), 0, 1).mul(float(1).sub(aliveF));
    const vis = mix(fade, float(1), aliveF);
    const live = step(0.001, vis);                    // empty slots collapse to zero area
    const hitPop = clamp(float(1).sub(u.time.sub(attA.z).mul(5)), 0, 1).mul(aliveF);
    const size = attA.w
      .mul(mix(float(1.5), float(1), aliveF))
      .mul(float(1).add(hitPop.mul(0.4)).add(spark.mul(0.8)))
      .mul(live);

    const mat = new THREE.MeshBasicNodeMaterial();
    mat.positionNode = vec3(
      posA.xy.add(positionGeometry.xy.mul(size)),
      mix(float(0.02), float(0.10), aliveF),          // corpses sit under the living
    );

    const tile = mix(float(3), datA.y, aliveF);       // tile 3 of the atlas is gore
    const tex = texture(atlasTexture, vec2(uv().x.add(tile).div(4), uv().y));
    const dry = mix(vec3(0.34, 0.07, 0.06), vec3(1), wet);
    const flash = hitPop;
    mat.colorNode = tex.rgb.mul(mix(dry, vec3(1), aliveF))
      .add(vec3(flash.mul(1.1), flash.mul(0.25), flash.mul(0.05)))
      .add(vec3(spark.mul(1.6), spark.mul(1.3), spark.mul(0.8)));
    mat.opacityNode = tex.a;
    mat.transparent = false;
    mat.alphaTest = 0.5;                              // cutout keeps depth sorting honest

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;

    // ---- bullet render: tiny additive tracers, positions read straight from the
    // same buffer the compute pass writes.
    const bGeo = new THREE.InstancedBufferGeometry();
    bGeo.setAttribute('position', src.getAttribute('position'));
    bGeo.setAttribute('uv', src.getAttribute('uv'));
    bGeo.setIndex(src.getIndex());
    bGeo.instanceCount = MAX_BULLETS;

    const bA = bullets.toAttribute();
    const bFlying = step(0.001, bA.w);
    // 0 -> 1 across the negative-life dust tail
    const bPuff = clamp(bA.w.negate().div(0.4), 0, 1).mul(step(-0.4, bA.w)).mul(float(1).sub(bFlying));
    const bAlive = max(bFlying, step(0.001, bPuff));
    const bMat = new THREE.MeshBasicNodeMaterial();
    // rounds swell just before they detonate, which is the only warning you get
    const bFlare = clamp(float(0.28).sub(bA.w).mul(6), 0, 1);
    // swells just before going off, then the dust blooms outward as it fades
    const bSize = float(0.42).add(bFlare.mul(1.4).mul(bFlying)).add(bPuff.mul(5.0)).mul(bAlive);
    bMat.positionNode = vec3(bA.xy.add(positionGeometry.xy.mul(bSize)), 0.55);
    // hot core fading to orange, and a stretch along travel would need the angle,
    // which the shader has: a round tracer reads fine at this size.
    const bd = length(uv().sub(vec2(0.5)));
    const bGlow = clamp(float(1).sub(bd.mul(2.2)), 0, 1);
    // tracer while flying, warm dust while puffing, fading as it expands
    const dust = vec3(0.9, 0.68, 0.44);
    const tracer = vec3(1.7, 1.25, 0.6);
    bMat.colorNode = mix(dust, tracer, bFlying).mul(bGlow);
    bMat.opacityNode = bGlow.mul(mix(clamp(float(1).sub(bPuff), 0, 1).mul(0.65), float(1), bFlying));
    bMat.transparent = true;
    bMat.depthWrite = false;
    bMat.blending = THREE.AdditiveBlending;

    this.bulletMesh = new THREE.Mesh(bGeo, bMat);
    this.bulletMesh.frustumCulled = false;
    this.bulletMesh.renderOrder = 3;

    this._spawnQueue = [];
    this._seed = 1;
  }

  // Must be called whenever the map changes: this uniform is what decides a leak.
  setBase(x, y) {
    this.u.basePos.value.set(x, y);
  }

  async init() {
    await this.renderer.computeAsync(this.initPass);
    await this.renderer.computeAsync(this.bulletClearPass);
  }

  // Muzzle events for this frame: {x, y, angle, rounds}. Rounds are clamped to
  // MUZZLE_BURST because the spawn dispatch is a fixed size.
  setMuzzles(list, damage, spread) {
    const n = Math.min(list.length, MAX_MUZZLES);
    let total = 0;
    for (let i = 0; i < n; i++) {
      const m = list[i];
      const rounds = Math.min(MUZZLE_BURST, Math.max(0, m.rounds));
      this.muzzles.array[i].set(m.x, m.y, m.angle, rounds);
      total += rounds;
    }
    this.u.muzzleCount.value = n;
    this.u.bulletDamage.value = damage;
    this.u.bulletSpread.value = spread;
    this.u.bulletCursor.value = this._bulletCursor ?? 0;
    this._muzzleCount = n;
    this._bulletCursor = ((this._bulletCursor ?? 0) + MAX_MUZZLES * MUZZLE_BURST) % MAX_BULLETS;
    return total;
  }

  // Full wipe for a restart: every slot emptied, every counter zeroed.
  async reset() {
    this._generation++;                 // discard any readback still in flight
    this.cursor = 0;
    this._spawnQueue.length = 0;
    this.stats = { kills: 0, leaks: 0, gold: 0, spawned: 0, alive: 0, recycled: 0, recycling: false };
    this._lastCounters = [0, 0, 0, 0];
    this._lastStuck = 0;
    this.pendingGold = 0;
    this.pendingLeaks = 0;
    this.density = new Uint32Array(DENS_W * DENS_H);
    this.u.turretCount.value = 0;
    this.u.blastCount.value = 0;
    this.initPass.count = MAX_ORCS;
    this._muzzleCount = 0;
    this._bulletCursor = 0;
    this.u.muzzleCount.value = 0;
    await this.renderer.computeAsync(this.counterResetPass);
    await this.renderer.computeAsync(this.initPass);
    await this.renderer.computeAsync(this.bulletClearPass);
  }

  // Queued rather than dispatched immediately so a wave can ask for several
  // archetypes in one tick without fighting over the spawn uniforms.
  spawn(count, { pos, hp, type, speed, gold, scale, spread = 1.6 }) {
    if (count <= 0) return;
    this._spawnQueue.push({ count: Math.min(count, SPAWN_BATCH), pos, hp, type, speed, gold, scale, spread });
  }

  update(dt, time) {
    const { renderer, u } = this;
    u.dt.value = dt;
    u.time.value = time;

    // Up to four spawn dispatches per frame; each is its own tiny dispatch so
    // the uniforms can differ between them.
    let bursts = 0;
    while (this._spawnQueue.length && bursts < 4) {
      const s = this._spawnQueue.shift();
      u.spawnCount.value = s.count;
      u.spawnCursor.value = this.cursor;
      u.spawnPos.value.set(s.pos.x, s.pos.y);
      u.spawnSpread.value = s.spread;
      u.spawnHp.value = s.hp;
      u.spawnType.value = s.type;
      u.spawnSpeed.value = s.speed;
      u.spawnGold.value = s.gold;
      u.spawnScale.value = s.scale;
      u.spawnSeed.value = (this._seed = (this._seed * 1664525 + 1013904223) & 0x7fffffff);
      renderer.compute(this.spawnPass);
      this.cursor = (this.cursor + s.count) % MAX_ORCS;
      this.stats.spawned += s.count;
      bursts++;
    }

    // Only dispatch over slots that have ever held an orc. Early waves cost a
    // few thousand threads instead of the full capacity, and the same window
    // bounds the draw call.
    const used = Math.min(MAX_ORCS, this.stats.spawned);
    this.used = used;
    this.mesh.geometry.instanceCount = Math.max(1, used);
    if (used > 0) {
      this.scatterPass.count = used;
      this.simPass.count = used;
      renderer.compute(this.scatterPass);
      renderer.compute(this.simPass);
      // bullets after scatter, so the hash they test against is this frame's
      if (this._muzzleCount > 0) renderer.compute(this.bulletSpawnPass);
      renderer.compute(this.bulletPass);
      // Density snapshot is grabbed here, before the clear pass wipes it.
      this._pollDensity();
      renderer.compute(this.clearPass);
      this._pollCounters();
    }
  }

  // Async staging readback, one in flight at most, never awaited by the frame.
  _pollCounters() {
    if (this._countersInFlight) return;
    this._countersInFlight = true;
    const gen = this._generation;
    this.renderer.getArrayBufferAsync(this._buffers.cnt.value).then((buf) => {
      if (gen !== this._generation) { this._countersInFlight = false; return; }
      const c = new Uint32Array(buf);
      const dKills = c[0] - this._lastCounters[0];
      const dLeaks = c[1] - this._lastCounters[1];
      const dGold = c[2] - this._lastCounters[2];
      this._lastCounters = [c[0], c[1], c[2], c[3]];
      this.stats.kills = c[0];
      this.stats.leaks = c[1];
      this.stats.gold = c[2];
      this.stats.hits = c[3];
      // stuck orc-frames since the last readback, so it reads as a rate
      this.stats.stuck = Math.max(0, c[4] - this._lastStuck);
      this._lastStuck = c[4];
      this.pendingGold += dGold;
      this.pendingLeaks += dLeaks;
      // Orcs overwritten by the spawn ring never report a death, so the derived
      // headcount would drift above capacity. Clamp it.
      this.stats.recycling = this.stats.spawned > this.capacity;
      // alive comes from the density sum in _pollDensity, which is exact.
      this._countersInFlight = false;
    this._generation = 0;
    }).catch((err) => {
      this._countersInFlight = false;
      if (!this._loggedCounterError) {
        this._loggedCounterError = true;
        console.error('[horde] counter readback failed:', err);
      }
    });
  }

  _pollDensity() {
    if (this._densityInFlight) return;
    if ((this._densityTick = (this._densityTick ?? 0) + 1) % 10 !== 0) return;
    this._densityInFlight = true;
    const gen = this._generation;
    // No reuse target here: that argument wants a three.js ReadbackBuffer, and
    // passing a plain ArrayBuffer made the readback throw into the catch below,
    // which silently blinded every turret that aims at the crowd.
    this.renderer.getArrayBufferAsync(this._buffers.dens.value).then((buf) => {
      if (gen !== this._generation) { this._densityInFlight = false; return; }
      this.density = new Uint32Array(buf);
      // Every living orc scatters exactly once, so this sum is the exact head
      // count. The derived spawned-minus-kills estimate drifts upward once the
      // spawn ring starts overwriting live orcs.
      // One pass builds both the exact head count and a coarse per-world-cell
      // map. The fine grid is now about one orc per cell, so anything asking
      // "where is the crowd" has to read a neighbourhood, not a cell.
      let sum = 0;
      const coarse = this.coarse;
      coarse.fill(0);
      for (let cy = 0; cy < DENS_H; cy++) {
        const row = cy * DENS_W;
        const wy = (cy / DENS_SCALE) | 0;
        for (let cx = 0; cx < DENS_W; cx++) {
          const n = this.density[row + cx];
          if (n === 0) continue;
          sum += n;
          coarse[wy * GRID_W + ((cx / DENS_SCALE) | 0)] += n;
        }
      }
      this.stats.alive = sum;
      this._densityInFlight = false;
    }).catch((err) => {
      this._densityInFlight = false;
      if (!this._loggedDensityError) {
        this._loggedDensityError = true;
        console.error('[horde] density readback failed, crowd aiming is blind:', err);
      }
    });
  }

  // How many orcs are within `r` world units of a point, from the async snapshot.
  crowdAround(x, y, r) {
    const c = this.coarse;
    const rc = Math.ceil(r);
    const cx = Math.round(x), cy = Math.round(y);
    let sum = 0;
    for (let oy = -rc; oy <= rc; oy++) {
      const gy = cy + oy;
      if (gy < 0 || gy >= GRID_H) continue;
      for (let ox = -rc; ox <= rc; ox++) {
        const gx = cx + ox;
        if (gx < 0 || gx >= GRID_W) continue;
        sum += c[gy * GRID_W + gx];
      }
    }
    return sum;
  }

  // Thickest part of the crowd within range, in world units, read off the coarse
  // per-world-cell map. Beams, mortars and machine guns all aim with this.
  densestNear(x, y, range) {
    const c = this.coarse;
    const r = Math.ceil(range);
    const cx = Math.round(x), cy = Math.round(y);
    let best = 0, bx = 0, by = 0;
    for (let oy = -r; oy <= r; oy++) {
      const gy = cy + oy;
      if (gy < 1 || gy >= GRID_H - 1) continue;
      for (let ox = -r; ox <= r; ox++) {
        const gx = cx + ox;
        if (gx < 1 || gx >= GRID_W - 1) continue;
        if (ox * ox + oy * oy > r * r) continue;
        const n = c[gy * GRID_W + gx];
        if (n > best) { best = n; bx = gx; by = gy; }
      }
    }
    if (best < 2) return null;
    return { x: bx + 0.5, y: by + 0.5, count: best };
  }

  takeGold() { const g = this.pendingGold; this.pendingGold = 0; return g; }
  takeLeaks() { const l = this.pendingLeaks; this.pendingLeaks = 0; return l; }

  // Weapons are flat shapes, not turrets: one turret can contribute several
  // (a bouncing beam sends one segment per leg).
  setWeapons(list) {
    const n = Math.min(list.length, MAX_TURRETS);
    for (let i = 0; i < n; i++) {
      const w = list[i];
      this.turretA.array[i].set(w.x0, w.y0, w.kind, w.dps);
      this.turretB.array[i].set(w.x1 ?? 0, w.y1 ?? 0, w.width ?? 0, w.radius ?? 0);
      this.turretC.array[i].set(w.cap ?? 1e9, 0, 0, 0);
    }
    this.u.turretCount.value = n;
  }

  setBlasts(list) {
    const n = Math.min(list.length, MAX_BLASTS);
    for (let i = 0; i < n; i++) {
      const b = list[i];
      this.blastArr.array[i].set(b.x, b.y, b.radius, b.dps);
      this.blastCaps.array[i].set(b.cap ?? 1e9, 0, 0, 0);
    }
    this.u.blastCount.value = n;
  }
}
