import test from 'node:test';
import assert from 'node:assert/strict';
import { Field } from '../src/field.js';
import { MAPS } from '../src/maps.js';
import { AUTHOR_W, AUTHOR_H, GRID_W, GRID_H, CELL_SCALE, RAMPART } from '../src/config.js';

test('every authored map loads and every portal can reach the base', () => {
  for (const map of MAPS) {
    const f = new Field(map);
    assert.equal(f.w, GRID_W);
    assert.equal(f.h, GRID_H);
    assert.ok(f.spawns.length >= 1, `${map.name}: no portal`);
    assert.ok(f.base, `${map.name}: no base`);
    assert.ok(f.reachable(), `${map.name}: portal cannot reach the base`);
  }
});

test('authored rows are the size the loader expects', () => {
  for (const map of MAPS) {
    assert.equal(map.rows.length, AUTHOR_H, `${map.name}: wrong row count`);
    for (const [i, row] of map.rows.entries()) {
      assert.equal(row.length, AUTHOR_W, `${map.name}: row ${i} is ${row.length} chars`);
    }
  }
});

test('map borders are rock and the base cell is open', () => {
  const f = new Field(MAPS[0]);
  for (let x = 0; x < f.w; x++) {
    assert.ok(f.isWall(x, 0) && f.isWall(x, f.h - 1), 'top/bottom border not sealed');
  }
  for (let y = 0; y < f.h; y++) {
    assert.ok(f.isWall(0, y) && f.isWall(f.w - 1, y), 'left/right border not sealed');
  }
  assert.ok(!f.isWall(f.base.x | 0, f.base.y | 0));
});

test('flow vectors are finite, in byte range, and non-zero on reachable dirt', () => {
  const f = new Field(MAPS[1]);
  for (let i = 0; i < f.flow.length; i++) {
    assert.ok(Number.isInteger(f.flow[i]) && f.flow[i] >= 0 && f.flow[i] <= 255);
  }
  let checked = 0;
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      const i = f.idx(x, y);
      if (f.walls[i] || !Number.isFinite(f.cost[i]) || f.cost[i] === 0) continue;
      const dx = f.flow[i * 4] / 255 * 2 - 1;
      const dy = f.flow[i * 4 + 1] / 255 * 2 - 1;
      assert.ok(Math.hypot(dx, dy) > 0.5, `flat direction at ${x},${y}`);
      checked++;
    }
  }
  assert.ok(checked > 1000, 'expected plenty of open cells to verify');
});

test('every rock cell has an escape direction, so a buried orc can walk out', () => {
  for (const map of MAPS) {
    const f = new Field(map);
    let checked = 0;
    for (let y = 0; y < f.h; y++) {
      for (let x = 0; x < f.w; x++) {
        const i = f.idx(x, y);
        if (!f.walls[i]) continue;
        const dx = f.flow[i * 4] / 255 * 2 - 1;
        const dy = f.flow[i * 4 + 1] / 255 * 2 - 1;
        assert.ok(Math.hypot(dx, dy) > 0.5, `${map.name}: rock at ${x},${y} traps anything standing in it`);
        checked++;
      }
    }
    assert.ok(checked > 500, `${map.name}: expected plenty of rock to verify`);
  }
});

test('walling the base off makes the portal unreachable, and undo restores it', () => {
  const f = new Field(MAPS[1]);
  assert.ok(f.reachable());
  const bx = Math.floor(f.base.x / CELL_SCALE);
  const by = Math.floor(f.base.y / CELL_SCALE);
  const ring = [];
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      if (!ox && !oy) continue;
      ring.push([bx + ox, by + oy]);
      f.setBlock(bx + ox, by + oy, true);
    }
  }
  f.bake();
  assert.equal(f.reachable(), false, 'sealing the base should cut every portal off');
  for (const [x, y] of ring) f.setBlock(x, y, false);
  f.bake();
  assert.ok(f.reachable(), 'undo should restore the path');
});

test('a half-block rampart narrows a corridor, a full block would seal it', () => {
  // by name, not index: maps are ordered by measured difficulty and that order moves
  const f = new Field(MAPS.find((m) => m.name === 'THE SNAKE'));
  const gx = 20, gy = f.spawns[0].y - 2; // inside the top corridor, on the rampart lattice

  assert.ok(f.canBuildCells(gx, gy, RAMPART), 'corridor should accept a rampart');
  f.setCells(gx, gy, RAMPART, true);
  f.bake();
  assert.ok(f.reachable(), 'a half-block rampart must leave a way through');

  f.setCells(gx, gy, RAMPART, false);
  f.bake();
  assert.ok(f.reachable());

  // The reason ramparts are not authored-block sized: 4 cells is the full
  // width of the corridor, so a block-sized rampart could only ever seal it.
  f.setCells(gx, gy, CELL_SCALE, true);
  f.bake();
  assert.equal(f.reachable(), false, 'a full block across a 4-cell corridor seals it');
});

test('cost rises as you walk away from the base', () => {
  const f = new Field(MAPS[2]);
  const b = f.idx(f.base.x | 0, f.base.y | 0);
  assert.equal(f.cost[b], 0);
  const far = f.idx(f.spawns[0].x | 0, f.spawns[0].y | 0);
  assert.ok(f.cost[far] > 5, 'portal should be a real distance from the base');
});

test('every map declares a wave target and a turret limit', () => {
  for (const map of MAPS) {
    assert.ok(Number.isInteger(map.waves) && map.waves > 0, `${map.name}: no wave target`);
    assert.ok(Number.isInteger(map.built) && map.built > 0, `${map.name}: no turret limit`);
  }
});
