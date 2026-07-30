// The map is drawn once into a canvas and shown on a single quad. Painting a
// rampart just redraws the canvas (a couple of ms), so authored rock and player
// rock look identical and cost nothing at render time.

import * as THREE from 'three/webgpu';
import { GRID_W, GRID_H, TILE_PX, CELL_SCALE } from './config.js';
import { PALETTE, rng, pixelTexture } from './art.js';

export class Ground {
  constructor(field) {
    this.field = field;
    this.w = GRID_W * TILE_PX;
    this.h = GRID_H * TILE_PX;

    this.dirt = document.createElement('canvas');
    this.dirt.width = this.w; this.dirt.height = this.h;
    this.#paintDirt(this.dirt.getContext('2d'));

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.w; this.canvas.height = this.h;
    this.ctx = this.canvas.getContext('2d');

    this.texture = pixelTexture(this.canvas);
    const mat = new THREE.MeshBasicNodeMaterial({ map: this.texture });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(GRID_W, GRID_H), mat);
    this.mesh.position.set(GRID_W / 2, GRID_H / 2, -1);
    this.rebuild();
  }

  // grid -> canvas, flipping y so the picture matches the authored ASCII
  px(gx, gy) { return [gx * TILE_PX, (GRID_H - 1 - gy) * TILE_PX]; }

  #paintDirt(ctx) {
    ctx.fillStyle = PALETTE.dirt;
    ctx.fillRect(0, 0, this.w, this.h);
    const r = rng(20260729);
    for (let gy = 0; gy < GRID_H; gy++) {
      for (let gx = 0; gx < GRID_W; gx++) {
        const [x, y] = this.px(gx, gy);
        for (let i = 0; i < 5; i++) {
          const s = 1 + Math.floor(r() * 3);
          ctx.fillStyle = r() > 0.5 ? PALETTE.dirtDark : PALETTE.dirtLight;
          ctx.fillRect(x + r() * (TILE_PX - s), y + r() * (TILE_PX - s), s, s);
        }
        if (r() > 0.93) {   // scattered pebbles
          ctx.fillStyle = '#7d5a2c';
          ctx.fillRect(x + r() * 12, y + r() * 12, 3, 2);
        }
      }
    }
  }

  rebuild() {
    const { ctx, field } = this;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.drawImage(this.dirt, 0, 0);

    // rock bodies
    ctx.fillStyle = PALETTE.rock;
    for (let gy = 0; gy < GRID_H; gy++) {
      for (let gx = 0; gx < GRID_W; gx++) {
        if (!field.isWall(gx, gy)) continue;
        const [x, y] = this.px(gx, gy);
        ctx.fillRect(x, y, TILE_PX, TILE_PX);
      }
    }

    // lit top edges, dark side edges, and a shadow cast onto the dirt below
    for (let gy = 0; gy < GRID_H; gy++) {
      for (let gx = 0; gx < GRID_W; gx++) {
        if (!field.isWall(gx, gy)) continue;
        const [x, y] = this.px(gx, gy);
        if (!field.isWall(gx, gy + 1)) {
          ctx.fillStyle = PALETTE.rockTop;
          ctx.fillRect(x, y, TILE_PX, 5);
          ctx.fillStyle = '#8a6540';
          ctx.fillRect(x, y, TILE_PX, 2);
        }
        if (!field.isWall(gx - 1, gy)) { ctx.fillStyle = PALETTE.rockEdge; ctx.fillRect(x, y, 2, TILE_PX); }
        if (!field.isWall(gx + 1, gy)) { ctx.fillStyle = PALETTE.rockEdge; ctx.fillRect(x + TILE_PX - 2, y, 2, TILE_PX); }
        if (!field.isWall(gx, gy - 1)) {
          ctx.fillStyle = PALETTE.rockEdge;
          ctx.fillRect(x, y + TILE_PX - 3, TILE_PX, 3);
          const g = ctx.createLinearGradient(0, y + TILE_PX, 0, y + TILE_PX + 7);
          g.addColorStop(0, 'rgba(0,0,0,0.42)');
          g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = g;
          ctx.fillRect(x, y + TILE_PX, TILE_PX, 7);
        }
      }
    }

    for (const s of field.spawns) this.#drawPortal(s);
    this.#drawBase(field.base);
    this.texture.needsUpdate = true;
  }

  #drawPortal(cell) {
    const { ctx } = this;
    const [x, y] = this.px(cell.x - CELL_SCALE / 2, cell.y + CELL_SCALE / 2 - 1);
    const s = CELL_SCALE * TILE_PX;
    ctx.fillStyle = '#2a1a0d';
    ctx.beginPath();
    ctx.ellipse(x + s / 2, y + s / 2, s * 0.34, s * 0.30, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#120a04';
    ctx.beginPath();
    ctx.ellipse(x + s / 2, y + s / 2, s * 0.24, s * 0.20, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#6b4a2a';
    for (let i = 0; i < 6; i++) {
      const a = Math.PI + (i / 5) * Math.PI;
      ctx.fillRect(x + s / 2 + Math.cos(a) * s * 0.33 - 3, y + s / 2 + Math.sin(a) * s * 0.30 - 3, 7, 7);
    }
  }

  #drawBase(cell) {
    const { ctx } = this;
    const [x, y] = this.px(cell.x - CELL_SCALE / 2, cell.y + CELL_SCALE / 2 - 1);
    const s = CELL_SCALE * TILE_PX;
    ctx.fillStyle = '#6e6a63';
    ctx.beginPath(); ctx.arc(x + s / 2, y + s / 2, s * 0.36, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#8d887f';
    ctx.beginPath(); ctx.arc(x + s / 2, y + s / 2, s * 0.28, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#4a4740';
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ctx.fillRect(x + s / 2 + Math.cos(a) * s * 0.32 - 4, y + s / 2 + Math.sin(a) * s * 0.32 - 4, 9, 9);
    }
    ctx.fillStyle = '#b8322a';
    ctx.fillRect(x + s / 2 - 2, y + s / 2 - s * 0.20, 4, s * 0.22);
    ctx.fillRect(x + s / 2 + 2, y + s / 2 - s * 0.20, s * 0.16, s * 0.11);
  }
}
