// The map is drawn once into a canvas and shown on a single quad. Painting a
// rampart just redraws the canvas (a couple of ms), so authored rock and player
// rock look identical and cost nothing at render time.
//
// Layout follows the reference game: orcs walk the dark trenches, turrets are
// built on the pale raised plateaus. Plateau corners are chamfered, so a lone
// block reads as an octagon rather than a square, and the whole map stops
// looking like a tile grid.

import * as THREE from 'three/webgpu';
import { GRID_W, GRID_H, TILE_PX, CELL_SCALE, NO_BUILD_RADIUS } from './config.js';
import { PALETTE, rng, pixelTexture } from './art.js';

const CHAMFER = 0.55;          // fraction of a cell cut off a convex corner

export class Ground {
  constructor(field) {
    this.field = field;
    this.w = GRID_W * TILE_PX;
    this.h = GRID_H * TILE_PX;

    this.trench = document.createElement('canvas');
    this.trench.width = this.w; this.trench.height = this.h;
    this.#paintTrench(this.trench.getContext('2d'));

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

  // Trench floor: dark packed earth with the reference's horizontal scratches.
  #paintTrench(ctx) {
    ctx.fillStyle = PALETTE.trench;
    ctx.fillRect(0, 0, this.w, this.h);
    const r = rng(20260729);
    for (let y = 0; y < this.h; y += 3) {
      for (let x = 0; x < this.w; x += 7) {
        if (r() > 0.55) continue;
        ctx.fillStyle = r() > 0.5 ? PALETTE.trenchDark : PALETTE.trenchLight;
        ctx.fillRect(x + r() * 4, y, 3 + r() * 5, 1);
      }
    }
    for (let i = 0; i < 900; i++) {          // scattered grit
      ctx.fillStyle = PALETTE.trenchDark;
      ctx.fillRect(r() * this.w, r() * this.h, 2, 2);
    }
  }

  rebuild() {
    const { ctx, field } = this;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.drawImage(this.trench, 0, 0);

    const T = TILE_PX;
    const cut = T * CHAMFER;
    const wall = (gx, gy) => field.isWall(gx, gy);

    // Plateau bodies, with convex corners chamfered so the silhouette is
    // polygonal. Drawn as one path per cell so the fill joins seamlessly.
    const facePath = () => {
      ctx.beginPath();
      for (let gy = 0; gy < GRID_H; gy++) {
        for (let gx = 0; gx < GRID_W; gx++) {
          if (!wall(gx, gy)) continue;
          const [x, y] = this.px(gx, gy);
          const up = wall(gx, gy + 1), dn = wall(gx, gy - 1);
          const lf = wall(gx - 1, gy), rt = wall(gx + 1, gy);
          // canvas y is flipped: "up" in world is -y on the canvas
          const pts = [];
          const push = (px, py) => pts.push([px, py]);
          if (!up && !lf) { push(x, y + cut); push(x + cut, y); } else push(x, y);
          if (!up && !rt) { push(x + T - cut, y); push(x + T, y + cut); } else push(x + T, y);
          if (!dn && !rt) { push(x + T, y + T - cut); push(x + T - cut, y + T); } else push(x + T, y + T);
          if (!dn && !lf) { push(x + cut, y + T); push(x, y + T - cut); } else push(x, y + T);
          ctx.moveTo(pts[0][0], pts[0][1]);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
          ctx.closePath();
        }
      }
    };

    // drop shadow onto the trench, offset down-right like the reference
    ctx.save();
    ctx.translate(4, 5);
    facePath();
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.fill();
    ctx.restore();

    // outline then face, so every plateau gets a dark rim
    facePath();
    ctx.strokeStyle = PALETTE.plateauEdge;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = PALETTE.plateau;
    ctx.fill();

    // top lip: a lighter band along the northern faces
    for (let gy = 0; gy < GRID_H; gy++) {
      for (let gx = 0; gx < GRID_W; gx++) {
        if (!wall(gx, gy) || wall(gx, gy + 1)) continue;
        const [x, y] = this.px(gx, gy);
        ctx.fillStyle = PALETTE.plateauLip;
        ctx.fillRect(x + (wall(gx - 1, gy) ? 0 : cut), y + 3, T - (wall(gx - 1, gy) ? 0 : cut) - (wall(gx + 1, gy) ? 0 : cut), 3);
      }
    }

    // sparse scrub on the plateaus, the way the reference dots its high ground
    const r = rng(4242);
    for (let gy = 1; gy < GRID_H - 1; gy++) {
      for (let gx = 1; gx < GRID_W - 1; gx++) {
        if (!wall(gx, gy) || r() > 0.06) continue;
        const [x, y] = this.px(gx, gy);
        ctx.fillStyle = PALETTE.scrub;
        ctx.fillRect(x + 4 + r() * 6, y + 5 + r() * 6, 3, 2);
        ctx.fillRect(x + 5 + r() * 6, y + 3 + r() * 6, 2, 3);
      }
    }

    for (const s of field.spawns) this.#drawPortal(s);
    this.#drawBase(field.base);
    this.texture.needsUpdate = true;
  }

  #drawPortal(cell) {
    const { ctx } = this;
    const [rx, ry] = this.px(cell.x, cell.y);
    // no-build ring, so the rule is visible on the map rather than only enforced
    ctx.save();
    ctx.beginPath();
    ctx.arc(rx, ry, NO_BUILD_RADIUS * TILE_PX, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(198,60,48,0.45)';
    ctx.lineWidth = 3;
    ctx.setLineDash([11, 9]);
    ctx.stroke();
    ctx.restore();

    const [x, y] = this.px(cell.x - CELL_SCALE / 2, cell.y + CELL_SCALE / 2 - 1);
    const s = CELL_SCALE * TILE_PX;
    ctx.fillStyle = '#2a1a0d';
    ctx.beginPath();
    ctx.ellipse(x + s / 2, y + s / 2, s * 0.36, s * 0.31, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0d0703';
    ctx.beginPath();
    ctx.ellipse(x + s / 2, y + s / 2, s * 0.25, s * 0.21, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = PALETTE.plateauEdge;
    for (let i = 0; i < 7; i++) {
      const a = Math.PI + (i / 6) * Math.PI;
      ctx.fillRect(x + s / 2 + Math.cos(a) * s * 0.35 - 3, y + s / 2 + Math.sin(a) * s * 0.31 - 3, 7, 7);
    }
  }

  #drawBase(cell) {
    const { ctx } = this;
    const [x, y] = this.px(cell.x - CELL_SCALE / 2, cell.y + CELL_SCALE / 2 - 1);
    const s = CELL_SCALE * TILE_PX;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.arc(x + s / 2 + 4, y + s / 2 + 5, s * 0.37, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#7a736a';
    ctx.beginPath(); ctx.arc(x + s / 2, y + s / 2, s * 0.37, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#9a9289';
    ctx.beginPath(); ctx.arc(x + s / 2, y + s / 2, s * 0.28, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#4a4740';
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ctx.fillRect(x + s / 2 + Math.cos(a) * s * 0.33 - 4, y + s / 2 + Math.sin(a) * s * 0.33 - 4, 9, 9);
    }
    ctx.fillStyle = '#c23a2e';
    ctx.fillRect(x + s / 2 - 2, y + s / 2 - s * 0.22, 4, s * 0.24);
    ctx.fillRect(x + s / 2 + 2, y + s / 2 - s * 0.22, s * 0.17, s * 0.12);
  }
}
