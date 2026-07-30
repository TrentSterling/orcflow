// Turret sprites, sweeping beams, blast flashes and the build ghost. All plain
// three.js meshes: there are at most a few dozen of them, so the CPU can own
// them without ever touching the horde.

import * as THREE from 'three/webgpu';
import { texture, uv, vec2 } from 'three/tsl';
import { makeTurretAtlas, makeGlow, makeBeam, makeLevelStrip } from './art.js';

const TURRET_SIZE = 2.7;
// turret behaviour -> atlas tile (blades, emitter, emitter, mortar)
const TILE_FOR_TYPE = [0, 1, 1, 2];

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.atlas = makeTurretAtlas();
    this.glowTex = makeGlow();
    this.beamTex = makeBeam();

    // One cutout material per atlas tile.
    this.turretMats = [0, 1, 2].map((tile) => {
      const m = new THREE.MeshBasicNodeMaterial();
      m.colorNode = texture(this.atlas, vec2(uv().x.add(tile).div(3), uv().y));
      m.opacityNode = texture(this.atlas, vec2(uv().x.add(tile).div(3), uv().y)).a;
      m.alphaTest = 0.5;
      return m;
    });

    // Additive layers stack: with dozens of turrets firing, full-strength quads
    // blow the screen out, so every layer gets an opacity budget.
    this.beamMat = new THREE.MeshBasicNodeMaterial({
      map: this.beamTex, transparent: true, depthWrite: false, opacity: 0.42,
      blending: THREE.AdditiveBlending,
    });
    this.coreMat = new THREE.MeshBasicNodeMaterial({
      map: this.beamTex, transparent: true, depthWrite: false, opacity: 0.8,
      blending: THREE.AdditiveBlending,
    });
    this.glowMat = new THREE.MeshBasicNodeMaterial({
      map: this.glowTex, transparent: true, depthWrite: false, opacity: 0.5,
      blending: THREE.AdditiveBlending,
    });
    // Dim wash drawn at the true damage diameter, so the blade turret's kill
    // zone is the thing you see rather than a small glow inside a big radius.
    this.zoneMat = new THREE.MeshBasicNodeMaterial({
      map: this.glowTex, transparent: true, depthWrite: false, opacity: 0.13,
      blending: THREE.AdditiveBlending,
    });

    // one cutout material per level, same trick as the turret tiles
    this.levelTex = makeLevelStrip(6);
    this.levelMats = Array.from({ length: 6 }, (_, i) => {
      const m = new THREE.MeshBasicNodeMaterial();
      const uvNode = vec2(uv().x.add(i).div(6), uv().y);
      m.colorNode = texture(this.levelTex, uvNode);
      m.opacityNode = texture(this.levelTex, uvNode).a;
      m.alphaTest = 0.3;
      m.transparent = false;
      return m;
    });
    this.levelPool = [];

    this.quad = new THREE.PlaneGeometry(1, 1);
    this.turretPool = [];
    this.beamPool = [];
    this.glowPool = [];
    this.zonePool = [];

    // build ghost: a tinted block plus a range ring
    this.ghost = new THREE.Mesh(this.quad, new THREE.MeshBasicNodeMaterial({
      color: 0x8fdc5a, transparent: true, opacity: 0.4, depthWrite: false,
    }));
    this.ghost.position.z = 0.5;
    this.ghost.visible = false;
    scene.add(this.ghost);

    const ring = new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 65 }, (_, i) => {
        const a = (i / 64) * Math.PI * 2;
        return new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
      }),
    );
    this.ring = new THREE.Line(ring, new THREE.LineBasicMaterial({
      color: 0xffe08a, transparent: true, opacity: 0.55,
    }));
    this.ring.position.z = 0.5;
    this.ring.visible = false;
    scene.add(this.ring);
  }

  // Index-addressed pools: slot i is always the same mesh, so a frame can never
  // hand the same mesh out twice.
  #at(pool, i, mat) {
    let mesh = pool[i];
    if (!mesh) {
      mesh = new THREE.Mesh(this.quad, mat);
      mesh.frustumCulled = false;
      pool[i] = mesh;
      this.scene.add(mesh);
    }
    mesh.visible = true;
    return mesh;
  }

  #hideFrom(pool, n) { for (let i = n; i < pool.length; i++) pool[i].visible = false; }

  // `segments` are flat {x0,y0,x1,y1,width,hot} beams: one for a locked beam,
  // one per leg for a bouncing one. The renderer does not care which.
  sync(turrets, segments, blasts, time) {
    let ti = 0, bi = 0, gi = 0, zi = 0, li = 0;

    for (const t of turrets) {
      const tile = TILE_FOR_TYPE[t.type] ?? 0;
      const mesh = this.#at(this.turretPool, ti, this.turretMats[tile]);
      mesh.material = this.turretMats[tile];
      mesh.position.set(t.x, t.y, 0.4);
      // Every turret is the size of its platform; the kill zone is shown by the
      // wash underneath instead of by inflating the sprite. Levels add a little
      // heft on top of that, so upgrades are visible in the silhouette too.
      const lv = t.level ?? 1;
      const grow = TURRET_SIZE * (1 + (lv - 1) * 0.06);
      mesh.scale.set(grow, grow, 1);
      // blades spin, emitters point where they aim, mortars sit still
      mesh.rotation.z = t.type === 0 ? time * 5.5 : (t.type === 3 ? 0 : t.angle);
      ti++;

      // pip strip under the turret
      const pips = this.#at(this.levelPool, li, this.levelMats[Math.min(5, lv - 1)]);
      pips.material = this.levelMats[Math.min(5, lv - 1)];
      pips.position.set(t.x, t.y - TURRET_SIZE * 0.62, 0.45);
      pips.scale.set(TURRET_SIZE * 0.95, TURRET_SIZE * 0.3, 1);
      li++;

      if (t.type === 0) {
        // wash at the real damage diameter
        const zone = this.#at(this.zonePool, zi, this.zoneMat);
        zone.position.set(t.x, t.y, 0.3);
        const zs = t.range * 2;
        zone.scale.set(zs, zs, 1);
        zi++;
        const pulse = 0.55 + 0.45 * Math.abs(Math.sin(time * 22 + t.x));
        const flash = this.#at(this.glowPool, gi, this.glowMat);
        flash.position.set(t.x, t.y, 0.55);
        const s = t.range * 0.55 * pulse;
        flash.scale.set(s, s, 1);
        gi++;
      }
    }

    for (const s of segments) {
      const dx = s.x1 - s.x0, dy = s.y1 - s.y0;
      const len = Math.hypot(dx, dy);
      if (len < 0.02) continue;
      const hot = s.hot ?? 1;
      const ang = Math.atan2(dy, dx);
      // wide soft body plus a thin hot core, so a beam looks like it is cutting
      const body = this.#at(this.beamPool, bi, this.beamMat);
      body.position.set(s.x0 + dx / 2, s.y0 + dy / 2, 0.6);
      body.material = this.beamMat;
      body.scale.set(len, Math.max(1.2, s.width * 3.6 * hot), 1);
      body.rotation.z = ang;
      bi++;
      const core = this.#at(this.beamPool, bi, this.coreMat);
      core.material = this.coreMat;
      core.position.set(s.x0 + dx / 2, s.y0 + dy / 2, 0.62);
      core.scale.set(len, Math.max(0.5, s.width * 1.5) * (0.85 + Math.sin(time * 30 + s.x0) * 0.15), 1);
      core.rotation.z = ang;
      bi++;
      // bloom where the leg lands, so a reflection reads as a hit
      const impact = this.#at(this.glowPool, gi, this.glowMat);
      impact.position.set(s.x1, s.y1, 0.66);
      const hs = (1.5 + Math.sin(time * 26 + s.x0) * 0.3) * hot;
      impact.scale.set(hs, hs, 1);
      gi++;
    }

    for (const b of blasts) {
      const g = this.#at(this.glowPool, gi, this.glowMat);
      g.position.set(b.x, b.y, 0.7);
      const s = b.radius * 2.6;
      g.scale.set(s, s, 1);
      gi++;
    }

    this.#hideFrom(this.levelPool, li);
    this.#hideFrom(this.turretPool, ti);
    this.#hideFrom(this.beamPool, bi);
    this.#hideFrom(this.glowPool, gi);
    this.#hideFrom(this.zonePool, zi);
  }

  setGhost(world, build, valid) {
    if (!world || !build) { this.ghost.visible = false; this.ring.visible = false; return; }
    const size = build.size ?? 3.0;
    this.ghost.visible = true;
    this.ghost.position.set(world.x, world.y, 0.5);
    this.ghost.scale.set(size, size, 1);
    this.ghost.material.color.set(valid ? 0x8fdc5a : 0xdc4a3a);
    if (build.kind === 'turret') {
      this.ring.visible = true;
      this.ring.position.set(world.x, world.y, 0.5);
      this.ring.scale.set(build.range, build.range, 1);
    } else {
      this.ring.visible = false;
    }
  }
}
