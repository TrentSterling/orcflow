// Flow field. Pure JS, no three.js, so it runs under node for tests.
//
// Dijkstra from the base outward over open cells (8-neighbour, no corner
// cutting), then one direction vector per cell pointing down the cost gradient.
// Packed into RGBA8 for the GPU:
//
//   R = dirX * 0.5 + 0.5
//   G = dirY * 0.5 + 0.5
//   B = 255 when the cell is rock (the sim reads this for collision)
//   A = normalised distance to base (debug / spawn logic)
//
// RGBA8 is filterable everywhere, and 8 bits of direction is plenty. Compute
// shaders cannot use filtered sampling, so the shader does its own bilinear
// blend of four textureLoads.

import { AUTHOR_W, AUTHOR_H, CELL_SCALE, GRID_W, GRID_H } from './config.js';

const DIAG = Math.SQRT2;
const NEIGHBOURS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, DIAG], [1, -1, DIAG], [-1, 1, DIAG], [-1, -1, DIAG],
];

export class Field {
  constructor(mapDef) {
    this.w = GRID_W;
    this.h = GRID_H;
    this.walls = new Uint8Array(this.w * this.h);
    // Float64 on purpose: the sqrt(2) diagonal steps are doubles, and rounding
    // them into a Float32 store makes the stale-entry check reject valid pops,
    // which silently truncates the flood fill.
    this.cost = new Float64Array(this.w * this.h);
    this.flow = new Uint8Array(this.w * this.h * 4);
    this.spawns = [];
    this.base = null;
    this.load(mapDef);
  }

  // Reload any map into this instance. Everything downstream keeps its reference,
  // which is what lets a restart or a map change happen without a page reload.
  load(mapDef) {
    this.name = mapDef.name;
    this.mapDef = mapDef;
    this.walls.fill(0);
    this.spawns = [];
    this.base = null;
    this.#parse(mapDef);
    this.bake();
  }

  // Authored rows are top-down; the grid is y-up so world coordinates match the
  // picture you drew.
  #parse(mapDef) {
    for (let ay = 0; ay < AUTHOR_H; ay++) {
      const row = (mapDef.rows[ay] ?? '').padEnd(AUTHOR_W, '.');
      for (let ax = 0; ax < AUTHOR_W; ax++) {
        const ch = row[ax];
        const edge = ax === 0 || ay === 0 || ax === AUTHOR_W - 1 || ay === AUTHOR_H - 1;
        const rock = edge || ch === '#';
        const gx = ax * CELL_SCALE;
        const gy = (AUTHOR_H - 1 - ay) * CELL_SCALE;
        for (let oy = 0; oy < CELL_SCALE; oy++) {
          for (let ox = 0; ox < CELL_SCALE; ox++) {
            this.walls[(gy + oy) * this.w + gx + ox] = rock ? 1 : 0;
          }
        }
        const centre = { x: gx + CELL_SCALE / 2, y: gy + CELL_SCALE / 2 };
        if (ch === 'S') this.spawns.push(centre);
        if (ch === 'B') this.base = centre;
      }
    }
    if (!this.base) throw new Error(`map "${mapDef.name}" has no base (B)`);
    if (!this.spawns.length) throw new Error(`map "${mapDef.name}" has no portal (S)`);
  }

  idx(x, y) { return y * this.w + x; }
  isWall(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return true;
    return this.walls[y * this.w + x] === 1;
  }

  // Authored-cell granularity block, which is how the player paints ramparts.
  canBuildBlock(bx, by) {
    if (bx <= 0 || by <= 0 || bx >= AUTHOR_W - 1 || by >= AUTHOR_H - 1) return false;
    const gx = bx * CELL_SCALE, gy = by * CELL_SCALE;
    for (let oy = 0; oy < CELL_SCALE; oy++) {
      for (let ox = 0; ox < CELL_SCALE; ox++) {
        if (this.walls[(gy + oy) * this.w + gx + ox]) return false;
      }
    }
    return true;
  }

  // Arbitrary-size footprint in sim cells. Ramparts are smaller than an authored
  // block on purpose: a corridor is one authored block wide, so a block-sized
  // rampart could only ever seal it, never narrow it.
  canBuildCells(gx, gy, size) {
    if (gx < 1 || gy < 1 || gx + size > this.w - 1 || gy + size > this.h - 1) return false;
    for (let oy = 0; oy < size; oy++) {
      for (let ox = 0; ox < size; ox++) {
        if (this.walls[(gy + oy) * this.w + gx + ox]) return false;
      }
    }
    return true;
  }

  setCells(gx, gy, size, rock) {
    for (let oy = 0; oy < size; oy++) {
      for (let ox = 0; ox < size; ox++) {
        const x = gx + ox, y = gy + oy;
        if (x < 0 || y < 0 || x >= this.w || y >= this.h) continue;
        this.walls[y * this.w + x] = rock ? 1 : 0;
      }
    }
  }

  setBlock(bx, by, rock) {
    const gx = bx * CELL_SCALE, gy = by * CELL_SCALE;
    for (let oy = 0; oy < CELL_SCALE; oy++) {
      for (let ox = 0; ox < CELL_SCALE; ox++) {
        this.walls[(gy + oy) * this.w + gx + ox] = rock ? 1 : 0;
      }
    }
  }

  // March a ray until it hits rock. Returns the last open point, how far it got,
  // and which axis was crossed so a beam can be reflected off that face.
  // Turrets stand on rock, so a ray almost always starts inside solid geometry.
  // Rock is ignored until the ray first reaches open ground, otherwise every beam
  // terminates at zero length against the platform it was fired from.
  rayHit(x, y, dx, dy, maxLen, step = 0.18) {
    let px = x, py = y, d = 0;
    let leaving = this.isWall(Math.floor(x), Math.floor(y));
    while (d < maxLen) {
      const nx = px + dx * step, ny = py + dy * step;
      const cellX = Math.floor(nx), cellY = Math.floor(ny);
      const solid = this.isWall(cellX, cellY);
      if (leaving) {
        if (!solid) leaving = false;
      } else if (solid) {
        const axis = cellX !== Math.floor(px) ? 'x' : 'y';
        return { x: px, y: py, dist: d, axis };
      }
      px = nx; py = ny; d += step;
    }
    return { x: px, y: py, dist: d, axis: null };
  }

  // Turrets are built ON the rock, on the plateaus above the trenches the orcs
  // walk. Two consequences worth keeping: placement can never affect pathing, and
  // a rampart is dual purpose, funnelling the horde and raising a new platform.
  isPlatform(gx, gy, size) {
    if (gx < 0 || gy < 0 || gx + size > this.w || gy + size > this.h) return false;
    for (let oy = 0; oy < size; oy++) {
      for (let ox = 0; ox < size; ox++) {
        if (!this.walls[(gy + oy) * this.w + gx + ox]) return false;
      }
    }
    return true;
  }

  reachable() {
    return this.spawns.every((s) => Number.isFinite(this.cost[this.idx(s.x | 0, s.y | 0)]));
  }

  // Dijkstra with a bucket queue: costs only ever grow by 1 or sqrt(2), so a
  // simple sorted insertion beats a heap at this size (5376 cells, sub-ms).
  bake() {
    const { w, h, cost, walls } = this;
    cost.fill(Infinity);
    const bx = this.base.x | 0, by = this.base.y | 0;
    const start = this.idx(bx, by);
    cost[start] = 0;

    // Small binary heap, plenty fast and keeps the memory flat.
    const heap = [start];
    const heapCost = [0];
    const push = (i, c) => {
      let n = heap.length;
      heap.push(i); heapCost.push(c);
      while (n > 0) {
        const p = (n - 1) >> 1;
        if (heapCost[p] <= heapCost[n]) break;
        [heap[p], heap[n]] = [heap[n], heap[p]];
        [heapCost[p], heapCost[n]] = [heapCost[n], heapCost[p]];
        n = p;
      }
    };
    const pop = () => {
      const top = heap[0];
      const lastI = heap.pop(), lastC = heapCost.pop();
      if (heap.length) {
        heap[0] = lastI; heapCost[0] = lastC;
        let n = 0;
        for (;;) {
          const l = n * 2 + 1, r = l + 1;
          let m = n;
          if (l < heap.length && heapCost[l] < heapCost[m]) m = l;
          if (r < heap.length && heapCost[r] < heapCost[m]) m = r;
          if (m === n) break;
          [heap[m], heap[n]] = [heap[n], heap[m]];
          [heapCost[m], heapCost[n]] = [heapCost[n], heapCost[m]];
          n = m;
        }
      }
      return top;
    };

    while (heap.length) {
      const c = heapCost[0];
      const cur = pop();
      if (c > cost[cur]) continue;
      const cx = cur % w, cy = (cur - (cur % w)) / w;
      for (const [dx, dy, step] of NEIGHBOURS) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (walls[ni]) continue;
        // No squeezing through a diagonal gap between two rocks.
        if (dx && dy && (walls[cy * w + nx] || walls[ny * w + cx])) continue;
        const nc = c + step;
        if (nc < cost[ni] - 1e-9) { cost[ni] = nc; push(ni, nc); }
      }
    }
    this.#bakeFlow();
  }

  // Rock cells deep inside a slab have no open neighbour, so a "cheapest open
  // neighbour" rule leaves them with a zero vector and anything standing there
  // is stuck forever. That happens for real the moment a player drops a rampart
  // on a crowd, so every rock cell gets an escape direction: breadth-first out
  // from the rock that touches open ground, each cell pointing at its parent.
  #bakeEscape(hasDir) {
    const { w, h, walls, flow } = this;
    const queue = new Int32Array(w * h);
    let head = 0, tail = 0;
    const seen = new Uint8Array(w * h);

    for (let i = 0; i < walls.length; i++) {
      if (walls[i] && hasDir[i]) { seen[i] = 1; queue[tail++] = i; }
    }

    const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    while (head < tail) {
      const cur = queue[head++];
      const cx = cur % w, cy = (cur - (cur % w)) / w;
      for (const [dx, dy] of STEPS) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (seen[ni] || !walls[ni]) continue;
        seen[ni] = 1;
        // point back at the cell that reached us: following it walks out
        flow[ni * 4] = Math.round((-dx * 0.5 + 0.5) * 255);
        flow[ni * 4 + 1] = Math.round((-dy * 0.5 + 0.5) * 255);
        queue[tail++] = ni;
      }
    }
  }

  #bakeFlow() {
    const { w, h, cost, walls, flow } = this;
    const hasDir = new Uint8Array(w * h);
    let maxCost = 1;
    for (let i = 0; i < cost.length; i++) {
      if (Number.isFinite(cost[i]) && cost[i] > maxCost) maxCost = cost[i];
    }
    this.maxCost = maxCost;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const o = i * 4;
        let bx = 0, by = 0, best = walls[i] ? Infinity : cost[i];

        for (const [dx, dy] of NEIGHBOURS) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (walls[ni]) continue;
          if (dx && dy && (walls[y * w + nx] || walls[ny * w + x])) continue;
          const c = cost[ni];
          if (c < best) { best = c; bx = dx; by = dy; }
        }

        const len = Math.hypot(bx, by) || 1;
        hasDir[i] = (bx || by) ? 1 : 0;
        flow[o] = Math.round((bx / len * 0.5 + 0.5) * 255);
        flow[o + 1] = Math.round((by / len * 0.5 + 0.5) * 255);
        flow[o + 2] = walls[i] ? 255 : 0;
        flow[o + 3] = Number.isFinite(cost[i]) ? Math.round(Math.min(1, cost[i] / maxCost) * 255) : 255;
      }
    }

    this.#bakeEscape(hasDir);
  }
}
