// In-game debug overlays. Press F.
//
// This exists because a whole class of bug in this project has been invisible:
// the flow field degenerating to a zero vector somewhere, which parks any orc
// standing there while the rest of the horde flows past and the kill counter
// stays perfectly healthy. Drawing the field makes that a red cell you can see
// instead of a bug report.

import * as THREE from 'three/webgpu';
import { GRID_W, GRID_H } from './config.js';
import { pixelTexture } from './art.js';

const CELL_PX = 8;              // arrow cell size on the debug canvas

export class FlowOverlay {
  constructor(scene, field) {
    this.field = field;
    this.canvas = document.createElement('canvas');
    this.canvas.width = GRID_W * CELL_PX;
    this.canvas.height = GRID_H * CELL_PX;
    this.ctx = this.canvas.getContext('2d');

    this.texture = pixelTexture(this.canvas);
    this.texture.magFilter = THREE.LinearFilter;
    const mat = new THREE.MeshBasicNodeMaterial({
      map: this.texture, transparent: true, depthWrite: false, opacity: 0.9,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(GRID_W, GRID_H), mat);
    this.mesh.position.set(GRID_W / 2, GRID_H / 2, 0.9);
    this.mesh.visible = false;
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
  }

  get visible() { return this.mesh.visible; }

  toggle() {
    this.mesh.visible = !this.mesh.visible;
    if (this.mesh.visible) this.rebuild();
    return this.mesh.visible;
  }

  // Canvas y is flipped relative to the grid, same as the ground.
  rebuild() {
    const { ctx, field } = this;
    const w = this.canvas.width, h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = 1;

    let degenerate = 0;
    for (let gy = 0; gy < GRID_H; gy++) {
      for (let gx = 0; gx < GRID_W; gx++) {
        const i = field.idx(gx, gy);
        const o = i * 4;
        const dx = field.flow[o] / 255 * 2 - 1;
        const dy = field.flow[o + 1] / 255 * 2 - 1;
        const rock = field.flow[o + 2] > 127;
        const len = Math.hypot(dx, dy);

        const px = gx * CELL_PX + CELL_PX / 2;
        const py = (GRID_H - 1 - gy) * CELL_PX + CELL_PX / 2;

        if (rock) {
          // rock cells carry escape vectors; show them faintly so a slab with no
          // way out is visible too
          ctx.strokeStyle = len > 0.35 ? 'rgba(90,120,200,0.35)' : 'rgba(255,0,0,0.9)';
        } else if (len > 0.35) {
          ctx.strokeStyle = 'rgba(120,255,140,0.85)';
        } else {
          // an open cell with no heading: anything standing here stops dead
          ctx.strokeStyle = 'rgba(255,40,40,1)';
          ctx.fillStyle = 'rgba(255,40,40,0.55)';
          ctx.fillRect(gx * CELL_PX, (GRID_H - 1 - gy) * CELL_PX, CELL_PX, CELL_PX);
          degenerate++;
        }

        const k = CELL_PX * 0.42;
        ctx.beginPath();
        ctx.moveTo(px - dx * k, py + dy * k);        // +y on canvas is -y in world
        ctx.lineTo(px + dx * k, py - dy * k);
        ctx.stroke();
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fillRect(px + dx * k - 1, py - dy * k - 1, 2, 2);
      }
    }

    this.degenerate = degenerate;
    this.texture.needsUpdate = true;
    return degenerate;
  }
}
