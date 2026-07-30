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

// Tiles: 0 blades, 1 beam emitter, 2 mortar. Drawn barrel-along-+x so the
// sprite can just be rotated to the aim angle.
export function makeTurretAtlas() {
  const S = 32;
  const c = canvas(S * 3, S);
  const ctx = c.getContext('2d');

  const base = (ox) => {
    ctx.fillStyle = '#2b2013';
    ctx.beginPath(); ctx.arc(ox + S / 2, S / 2, 12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#6b4f2e';
    ctx.beginPath(); ctx.arc(ox + S / 2, S / 2, 10, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#3b2b18';
    ctx.beginPath(); ctx.arc(ox + S / 2, S / 2, 6, 0, Math.PI * 2); ctx.fill();
  };

  // 0: crossed blades
  base(0);
  ctx.save();
  ctx.translate(S / 2, S / 2);
  for (const a of [0.6, 0.6 + Math.PI / 2]) {
    ctx.save(); ctx.rotate(a);
    ctx.fillStyle = PALETTE.steel; ctx.fillRect(-14, -1.5, 28, 3);
    ctx.fillStyle = '#8f959e'; ctx.fillRect(-14, 0.5, 28, 1);
    ctx.restore();
  }
  ctx.fillStyle = PALETTE.gold;
  ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // 1: beam emitter
  base(S);
  ctx.save();
  ctx.translate(S + S / 2, S / 2);
  ctx.fillStyle = '#8e949c'; ctx.fillRect(0, -3, 15, 6);
  ctx.fillStyle = '#d9dee6'; ctx.fillRect(0, -3, 15, 2);
  ctx.fillStyle = '#ff5a3c'; ctx.fillRect(13, -2, 3, 4);
  ctx.restore();

  // 2: mortar
  base(S * 2);
  ctx.save();
  ctx.translate(S * 2 + S / 2, S / 2);
  ctx.fillStyle = '#4a4f57';
  ctx.beginPath(); ctx.arc(0, 0, 8, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#20242a';
  ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#7c838d';
  ctx.fillRect(-9, -2, 4, 4); ctx.fillRect(5, -2, 4, 4);
  ctx.restore();

  return pixelTexture(c);
}

// Level pips: one tile per turret level, so an upgraded turret is readable at a
// glance instead of only in its damage numbers.
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
