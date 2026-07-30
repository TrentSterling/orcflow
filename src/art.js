// Every texture is generated at boot on a 2D canvas: no asset files, and the
// palette lives in one place. Everything is drawn at pixel scale and sampled
// with NearestFilter for a chunky top-down look.

import * as THREE from 'three/webgpu';
import { SPRITE_PX } from './config.js';

// Reference palette: orcs walk the dark trench floor, turrets are built on the
// pale plateaus above. Everything else keys off these.
export const PALETTE = {
  trench: '#7d4c26',
  trenchDark: '#6b3f1d',
  trenchLight: '#8c5931',
  plateau: '#d2ab7d',
  plateauLip: '#e6c69c',
  plateauEdge: '#4a2d16',
  scrub: '#5d6b2c',
  blood: '#5f1010',
  gold: '#e8c33c',
  steel: '#c9cdd4',
  ui: '#f2e2c0',
};

const canvas = (w, h) => {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
};

// Deterministic noise so a rebuild of the ground never shimmers.
export function rng(seed) {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

const BODY = [
  [3, 6], [4, 10], [5, 12], [6, 12], [7, 12], [8, 12], [9, 10], [10, 8], [11, 6],
];

function drawOrc(ctx, ox, body, dark, light) {
  const cx = SPRITE_PX / 2;
  // outline first, one pixel fatter all round
  ctx.fillStyle = dark;
  for (const [y, w] of BODY) ctx.fillRect(ox + cx - w / 2 - 1, y - 1, w + 2, 3);
  ctx.fillStyle = body;
  for (const [y, w] of BODY) ctx.fillRect(ox + cx - w / 2, y, w, 1);
  // lit top edge
  ctx.fillStyle = light;
  ctx.fillRect(ox + cx - 4, 4, 8, 1);
  ctx.fillRect(ox + cx - 5, 5, 10, 1);
  // eyes and tusks
  ctx.fillStyle = '#14180c';
  ctx.fillRect(ox + cx - 3, 7, 2, 2);
  ctx.fillRect(ox + cx + 1, 7, 2, 2);
  ctx.fillStyle = '#fff6d8';
  ctx.fillRect(ox + cx - 3, 10, 1, 1);
  ctx.fillRect(ox + cx + 2, 10, 1, 1);
  // feet
  ctx.fillStyle = dark;
  ctx.fillRect(ox + cx - 4, 12, 3, 2);
  ctx.fillRect(ox + cx + 1, 12, 3, 2);
}

function drawGore(ctx, ox) {
  const r = rng(7331);
  ctx.fillStyle = PALETTE.blood;
  for (let i = 0; i < 26; i++) {
    const a = r() * Math.PI * 2;
    const d = r() * 6.2;
    const s = 1 + Math.floor(r() * 3);
    ctx.fillRect(ox + 8 + Math.cos(a) * d - s / 2, 8 + Math.sin(a) * d - s / 2, s, s);
  }
  ctx.fillStyle = '#7d1c14';
  for (let i = 0; i < 8; i++) {
    const a = r() * Math.PI * 2;
    const d = r() * 3.2;
    ctx.fillRect(ox + 8 + Math.cos(a) * d, 8 + Math.sin(a) * d, 2, 2);
  }
}

// Tiles: 0 grunt, 1 brute, 2 runner, 3 gore
export function makeOrcAtlas() {
  const c = canvas(SPRITE_PX * 4, SPRITE_PX);
  const ctx = c.getContext('2d');
  drawOrc(ctx, 0, '#4f7a2c', '#1d2a12', '#79a344');
  drawOrc(ctx, SPRITE_PX, '#b58a3c', '#3d2b0e', '#d8b163');
  drawOrc(ctx, SPRITE_PX * 2, '#7fa851', '#243318', '#a6cc78');
  drawGore(ctx, SPRITE_PX * 3);
  return pixelTexture(c);
}

// Turret atlas: five behaviours x three tiers, so a turret's silhouette changes
// as it climbs. Tier is level 1-2, 3-4, 5-6. Everything is drawn barrel-along-+x
// so the sprite can simply be rotated to the aim angle.
//
// Column order: blades, beam, bounce, mortar, machine gun. 15 tiles.
export const TURRET_TIERS = 3;
export const TURRET_TILES = 15;

const CHASSIS = [
  { ring: '#2b2013', body: '#6b4f2e', core: '#3b2b18' },   // tier 0, timber
  { ring: '#232a33', body: '#5e6b78', core: '#2b333d' },   // tier 1, plated
  { ring: '#1d2733', body: '#7d8ea3', core: '#28394d' },   // tier 2, alloy
];

const ACCENT = ['#e8c33c', '#d770ff', '#7ef0ff'];          // gold, violet, plasma

export function makeTurretAtlas() {
  const S = 32;
  const c = canvas(S * TURRET_TILES, S);
  const ctx = c.getContext('2d');

  const base = (ox, tier, r = 12) => {
    const k = CHASSIS[tier];
    ctx.fillStyle = k.ring;
    ctx.beginPath(); ctx.arc(ox + S / 2, S / 2, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = k.body;
    ctx.beginPath(); ctx.arc(ox + S / 2, S / 2, r - 2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = k.core;
    ctx.beginPath(); ctx.arc(ox + S / 2, S / 2, r - 6, 0, Math.PI * 2); ctx.fill();
    if (tier === 2) {                       // alloy tier gets rivets
      ctx.fillStyle = k.ring;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        ctx.fillRect(ox + S / 2 + Math.cos(a) * (r - 3) - 1, S / 2 + Math.sin(a) * (r - 3) - 1, 2, 2);
      }
    }
  };

  // ---- blades: 2 -> 3 -> 4 arms, longer and brighter each tier
  for (let t = 0; t < 3; t++) {
    const ox = t * S;
    base(ox, t);
    const arms = 2 + t;
    const len = 13 + t * 1.5;
    ctx.save();
    ctx.translate(ox + S / 2, S / 2);
    for (let i = 0; i < arms; i++) {
      ctx.save();
      ctx.rotate(0.4 + (i / arms) * Math.PI * 2);
      ctx.fillStyle = PALETTE.steel; ctx.fillRect(-len, -1.5 - t * 0.4, len * 2, 3 + t * 0.8);
      ctx.fillStyle = '#8f959e'; ctx.fillRect(-len, 0.5, len * 2, 1);
      ctx.restore();
    }
    ctx.fillStyle = ACCENT[t];
    ctx.beginPath(); ctx.arc(0, 0, 3 + t, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // ---- beam: single lens -> shrouded dual -> spinning optic ring
  for (let t = 0; t < 3; t++) {
    const ox = (3 + t) * S;
    base(ox, t);
    ctx.save();
    ctx.translate(ox + S / 2, S / 2);
    const barrels = t === 0 ? [0] : (t === 1 ? [-2.5, 2.5] : [-3.5, 0, 3.5]);
    for (const off of barrels) {
      ctx.fillStyle = '#8e949c'; ctx.fillRect(0, off - 1.6, 15 + t, 3.2);
      ctx.fillStyle = '#d9dee6'; ctx.fillRect(0, off - 1.6, 15 + t, 1);
      ctx.fillStyle = ACCENT[t]; ctx.fillRect(13 + t, off - 1.2, 3, 2.4);
    }
    if (t >= 1) {                            // energy shroud
      ctx.strokeStyle = ACCENT[t]; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(2, 0, 7 + t, -1.1, 1.1); ctx.stroke();
    }
    ctx.restore();
  }

  // ---- bounce: prism emitter, facets multiply with tier
  for (let t = 0; t < 3; t++) {
    const ox = (6 + t) * S;
    base(ox, t);
    ctx.save();
    ctx.translate(ox + S / 2, S / 2);
    ctx.fillStyle = '#8e949c'; ctx.fillRect(0, -2, 12, 4);
    const facets = 3 + t * 2;
    ctx.fillStyle = ACCENT[t];
    for (let i = 0; i < facets; i++) {
      const a = (i / facets) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 8, Math.sin(a) * 8);
      ctx.lineTo(Math.cos(a + 0.5) * 5, Math.sin(a + 0.5) * 5);
      ctx.lineTo(0, 0);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  // ---- mortar: single tube -> twin battery -> salvo pod
  for (let t = 0; t < 3; t++) {
    const ox = (9 + t) * S;
    base(ox, t, 13);
    ctx.save();
    ctx.translate(ox + S / 2, S / 2);
    const tubes = t === 0 ? [[0, 0]] : (t === 1 ? [[-4, 0], [4, 0]] : [[-4, -4], [4, -4], [-4, 4], [4, 4]]);
    for (const [tx, ty] of tubes) {
      ctx.fillStyle = '#4a4f57';
      ctx.beginPath(); ctx.arc(tx, ty, t === 2 ? 3.6 : 5.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#15181c';
      ctx.beginPath(); ctx.arc(tx, ty, t === 2 ? 2.2 : 3.4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = ACCENT[t];
    ctx.fillRect(-1.5, -13, 3, 3);
    ctx.restore();
  }

  // ---- machine gun: single barrel -> twin rotary -> quad gatling
  for (let t = 0; t < 3; t++) {
    const ox = (12 + t) * S;
    base(ox, t);
    ctx.save();
    ctx.translate(ox + S / 2, S / 2);
    const rows = t === 0 ? [0] : (t === 1 ? [-2.6, 2.6] : [-4, -1.3, 1.3, 4]);
    for (const off of rows) {
      ctx.fillStyle = '#7c838d'; ctx.fillRect(0, off - 1.1, 14 + t * 2, 2.2);
      ctx.fillStyle = '#c9cdd4'; ctx.fillRect(0, off - 1.1, 14 + t * 2, 0.9);
    }
    ctx.fillStyle = CHASSIS[t].ring;         // ammo drum
    ctx.beginPath(); ctx.arc(-4, 0, 5 + t, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = ACCENT[t];
    ctx.beginPath(); ctx.arc(-4, 0, 2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  return pixelTexture(c);
}

// Level pips: one tile per turret level, so the exact level is readable at a
// glance even between tier changes.
export function makeLevelStrip(levels = 6) {
  const tw = 16, th = 5;
  const c = canvas(tw * levels, th);
  const ctx = c.getContext('2d');
  for (let lv = 1; lv <= levels; lv++) {
    const ox = (lv - 1) * tw;
    for (let i = 0; i < levels; i++) {
      const x = ox + 2 + i * ((tw - 4) / levels);
      const filled = i < lv;
      ctx.fillStyle = filled ? (lv === levels ? '#ffe98a' : PALETTE.gold) : 'rgba(0,0,0,0.55)';
      ctx.fillRect(x, 1, 1.6, 3);
    }
  }
  return pixelTexture(c);
}

// Soft additive blob for muzzle flashes, blasts and beam glow.
export function makeGlow() {
  const c = canvas(64, 64);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,236,170,0.85)');
  g.addColorStop(0.6, 'rgba(255,150,60,0.28)');
  g.addColorStop(1, 'rgba(255,110,30,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Beam quad texture: hot core, soft edges, mapped along +x.
export function makeBeam() {
  const c = canvas(64, 16);
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 16);
  g.addColorStop(0, 'rgba(255,170,60,0)');
  g.addColorStop(0.38, 'rgba(255,214,120,0.75)');
  g.addColorStop(0.5, 'rgba(255,255,240,1)');
  g.addColorStop(0.62, 'rgba(255,214,120,0.75)');
  g.addColorStop(1, 'rgba(255,170,60,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 16);
  // No taper: a bounce leg is hot along its whole length, and the impact end
  // gets its own glow sprite instead.
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function pixelTexture(canvasEl) {
  const t = new THREE.CanvasTexture(canvasEl);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
