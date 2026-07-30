// ORCFLOW - tuning constants. One grid cell = one world unit.

export const AUTHOR_W = 24;              // authored ASCII map width
export const AUTHOR_H = 14;              // authored ASCII map height
export const CELL_SCALE = 4;             // authored char -> 4x4 sim cells
export const GRID_W = AUTHOR_W * CELL_SCALE;   // 96
export const GRID_H = AUTHOR_H * CELL_SCALE;   // 56

export const DENS_SCALE = 2;             // density cells per world unit
export const DENS_W = GRID_W * DENS_SCALE;
export const DENS_H = GRID_H * DENS_SCALE;

// ?orcs=250000 raises the buffer capacity for benchmark runs. Guarded so the
// node tests can import this file.
const QUERY = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
export const PARAMS = QUERY;
// The GPU is nowhere near the limit at 100k (compute measured well under a
// millisecond), so the default cap is generous. Past the cap the spawn ring
// wraps and overwrites the oldest slots, so the headcount plateaus instead of
// climbing: the HUD flags that as recycling.
export const MAX_ORCS = Math.max(2048, Math.min(2000000, Number(QUERY.get('orcs')) || 250000));
export const SPAWN_BATCH = 2048;         // hard cap on orcs spawned in one frame
// Each bouncing beam spends one slot per leg, so this is a shape budget rather
// than a turret budget.
export const MAX_TURRETS = 128;
export const MAX_BLASTS = 48;
export const CORPSE_FADE = 7.0;          // seconds a corpse lingers before its slot is reusable

export const TILE_PX = 16;               // ground texture pixels per cell
export const SPRITE_PX = 16;             // orc sprite size in atlas
export const SEPARATION = 3.2;           // crowd push strength (fraction of max speed)

// Orc archetypes. CPU writes these into the GPU buffers at spawn time,
// so adding a type never touches shader code.
export const ORC_TYPES = [
  { name: 'grunt',  hp: 12,  speed: 4.2, gold: 1, scale: 0.60 },
  { name: 'brute',  hp: 160, speed: 2.6, gold: 8, scale: 0.95 },
  { name: 'runner', hp: 7,   speed: 7.4, gold: 2, scale: 0.50 },
];

// Rampart footprint in sim cells: half an authored block, so a 4-cell corridor
// can be narrowed to 2 instead of only being sealed.
export const RAMPART = 2;

export const BASE_HP = 90;
export const START_GOLD = 320;

// Turret behaviours (distinct from the two GPU damage shapes):
//   0 blades  spinning disc
//   1 beam    locks onto the thickest crowd and holds there, so it carves
//   2 bounce  zig-zag beam that reflects off rock, one segment per leg
//   3 mortar  lobs blasts at the thickest crowd
export const BUILDS = [
  { key: '1', id: 'wall',   name: 'RAMPART', cost: 8,   kind: 'wall', size: RAMPART },
  { key: '2', id: 'blades', name: 'BLADES',  cost: 60,  kind: 'turret', type: 0, range: 5.5,  dps: 95 },
  { key: '3', id: 'beam',   name: 'BEAM',    cost: 180, kind: 'turret', type: 1, range: 26.0, dps: 520, width: 1.0, dwell: 1.5 },
  { key: '4', id: 'bounce', name: 'BOUNCE',  cost: 220, kind: 'turret', type: 2, range: 74.0, dps: 300, width: 0.8, bounces: 5, sweep: 0.5 },
  { key: '5', id: 'mortar', name: 'MORTAR',  cost: 240, kind: 'turret', type: 3, range: 30.0, dps: 900, blast: 4.2, cooldown: 2.4 },
];

export const BLAST_LIFE = 0.45;          // seconds a mortar blast applies damage
