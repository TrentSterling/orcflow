// ORCFLOW - tuning constants. One grid cell = one world unit.

export const AUTHOR_W = 24;              // authored ASCII map width
export const AUTHOR_H = 14;              // authored ASCII map height
export const CELL_SCALE = 4;             // authored char -> 4x4 sim cells
export const GRID_W = AUTHOR_W * CELL_SCALE;   // 96
export const GRID_H = AUTHOR_H * CELL_SCALE;   // 56

// Finer grid than before: cells about one orc wide, so it doubles as a spatial
// hash for exact pairwise separation instead of only a density field.
export const DENS_SCALE = 4;
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
// Capacity comes from the saved setting unless a URL param overrides it. Read
// directly rather than importing save.js: config must stay importable by node.
function savedOrcCap() {
  try {
    if (typeof localStorage === 'undefined') return null;
    return JSON.parse(localStorage.getItem('orcflow.save.v1'))?.settings?.orcCap ?? null;
  } catch { return null; }
}
export const MAX_ORCS = Math.max(2048, Math.min(2000000,
  Number(QUERY.get('orcs')) || savedOrcCap() || 500000));
export const SPAWN_BATCH = 2048;         // hard cap on orcs spawned in one frame
// Each bouncing beam spends one slot per leg, so this is a shape budget rather
// than a turret budget.
export const MAX_TURRETS = 256;
export const MAX_BLASTS = 48;

// A round pierces until its life runs out, then detonates. Each hit costs life,
// so the pierce budget and the range are the same number.
export const BULLET_PIERCE_COST = 0.22;
export const BULLET_BLAST = 2.4;         // detonation radius at end of life
export const BULLET_BLAST_MULT = 2.2;    // detonation damage vs a direct hit

// Individual projectiles, on the GPU like everything else. One vec4 per bullet
// (x, y, angle, life) keeps this inside the 8-storage-buffer limit, with speed and
// damage as uniforms since there is one bullet type.
export const MAX_BULLETS = 60000;
export const MAX_MUZZLES = 16;           // guns that can fire in one frame
export const MUZZLE_BURST = 12;          // bullets one gun can emit per frame
export const BULLET_SPEED = 46;
export const BULLET_LIFE = 1.1;
// Corpses ARE the blood system, so they linger. A slot only comes back when the
// spawn ring wraps around to it anyway, and at half a million slots that is a
// very long time.
export const CORPSE_FADE = 80.0;

export const TILE_PX = 16;               // ground texture pixels per cell
export const SPRITE_PX = 16;             // orc sprite size in atlas
// Contact physics, not steering. Orcs are discs that push each other apart and
// cancel the closing part of their relative velocity, resolved twice a frame
// against the spatial hash. The flow field is the only thing that steers.
export const BUCKET_K = 8;
export const ORC_RADIUS = 0.22;          // half a grunt, for circle overlap
export const RESTITUTION = 0.65;         // share of an overlap corrected per relaxation pass
// Orc archetypes. CPU writes these into the GPU buffers at spawn time,
// so adding a type never touches shader code.
export const ORC_TYPES = [
  { name: 'grunt',  hp: 12,  speed: 4.2, gold: 1, scale: 0.46 },
  { name: 'brute',  hp: 160, speed: 2.6, gold: 8, scale: 0.80 },
  { name: 'runner', hp: 7,   speed: 7.4, gold: 2, scale: 0.40 },
];

// Rampart footprint in sim cells: half an authored block, so a 4-cell corridor
// can be narrowed to 2 instead of only being sealed.
export const RAMPART = 2;

// Ramparts are destructible. The reference game has no player walls at all: the
// path is fixed and you defend it. Letting the player reroute the horde is more
// interesting than that, but only if a wall is a delaying action you have to
// defend rather than a permanent solve, so the orcs chew through it.
export const RAMPART_HP = 1100;
export const CHEW_DPS = 1.1;             // damage per orc pressed against it, per second

// Turret footprint in sim cells, snapped to its own lattice like ramparts.
export const TURRET_SIZE = 2;

// Per-type limits, the way the reference does it (its hotbar reads 2/15, 8/10).
// A flat total was an arbitrary gate; a limit per weapon is a real decision about
// composition, and it is the only thing that can bound total throughput in a
// design where area damage scales with crowd density. Growth inside a run comes
// from upgrades, not from more turrets.
//
// MAX_BUILT is now only the technical ceiling: every weapon shape has to fit the
// uniform array the shader loops over, and a bouncing beam spends a slot per leg.
export const MAX_BUILT = 110;

// Nothing may be built within this radius of a portal. Camping the spawn made
// the rest of the map irrelevant: the horde never got anywhere.
export const NO_BUILD_RADIUS = 9.5;

// A kill pays the full bounty at your doorstep and this fraction at the portal,
// scaled by how far along the path the orc actually got. Forward defence stops
// funding itself, so the whole route matters.
export const BOUNTY_FLOOR = 0.15;

export const BASE_HP = 90;
export const START_GOLD = 320;

// Turret behaviours (distinct from the two GPU damage shapes):
//   0 blades  spinning disc
//   1 beam    locks onto the thickest crowd and holds there, so it carves
//   2 bounce  zig-zag beam that reflects off rock, one segment per leg
//   3 mortar  lobs blasts at the thickest crowd
export const BUILDS = [
  { key: '1', id: 'wall',   name: 'RAMPART', cost: 8,   kind: 'wall', size: RAMPART, escalate: 1.04 },
// Throughput is dps x hitsPerSec. Keeping those products in the same ballpark is
// what makes the choice about *shape* (a disc, a line, a bouncing line, a shell)
// instead of one weapon quietly doing all the work: the beam used to be worth
// nine blades.
  { key: '2', id: 'blades', name: 'BLADES',  cost: 60,  kind: 'turret', type: 0, range: 5.5,  dps: 95,  hitsPerSec: 300, limit: 10 },
  // type 4: real projectiles. Each round is an entity that flies, can miss, and
  // dies on the first orc it touches.
  { key: '3', id: 'gun',    name: 'MG NEST', cost: 95,  kind: 'turret', type: 4, range: 17.0, damage: 26, rpm: 660, spread: 0.10, limit: 10 },
  { key: '4', id: 'beam',   name: 'BEAM',    cost: 170, kind: 'turret', type: 1, range: 26.0, dps: 165, width: 1.4, dwell: 1.5, hitsPerSec: 240, limit: 5 },
  { key: '5', id: 'bounce', name: 'BOUNCE',  cost: 210, kind: 'turret', type: 2, range: 40.0, dps: 200, width: 1.0, bounces: 4, sweep: 0.5, hitsPerSec: 230, limit: 5 },
  { key: '6', id: 'mortar', name: 'MORTAR',  cost: 240, kind: 'turret', type: 3, range: 30.0, dps: 900, blast: 4.6, cooldown: 2.4, hitsPerSec: 300, limit: 5 },
];

// Active abilities, the thing the original uses to survive density spikes.
export const ABILITIES = [
  {
    key: 'q', id: 'strike', name: 'AIRSTRIKE', cooldown: 14,
    radius: 4.6, dps: 3200, life: 0.8, count: 9, spacing: 4.6, hitsPerSec: 900, stagger: 0.05,
  },
  {
    key: 'e', id: 'nuke', name: 'NUKE', cooldown: 55,
    radius: 15.0, dps: 9000, life: 1.1, count: 1, spacing: 0, hitsPerSec: 6000,
  },
];

// Speeds the player can pick. The sim runs N fixed substeps a frame rather than a
// fatter dt, so fast forward is exact rather than sloppy.
export const SPEEDS = [1, 2, 3, 5];
// unlocked by the TIME DILATION node
export const SPEEDS_FAST = [1, 2, 3, 5, 8, 12];

// Every upgrade level changes behaviour, not just a damage number, and the tier
// (levels 1-2, 3-4, 5-6) changes the silhouette and the effect colour.
//   blades  more arms, wider disc
//   mg      faster fire, tighter spread, hotter tracers
//   beam    thicker beam
//   bounce  an extra reflection leg at 3 and 5
//   mortar  an extra shell in the salvo at 3 and 5
export const UPGRADE = {
  dps: 1.55,
  hits: 1.45,
  range: 1.05,
  rpm: 1.22,
  spread: 0.86,
  width: 1.16,
  blast: 1.07,
  legsAt: [3, 5],
  salvoAt: [3, 5],
};

export const tierOf = (level) => (level <= 2 ? 0 : level <= 4 ? 1 : 2);

// Selling refunds this share of everything sunk into a turret.
export const SELL_REFUND = 0.6;

export const BLAST_LIFE = 0.45;          // seconds a mortar blast applies damage
