// Meta progression. Relics are earned from every run, won or lost, and spent on a
// tree that persists across runs.
//
// The design here is a direct response to what players complained about in the
// game this one is an homage to:
//
//   "forced to replay earlier levels to farm currency"  -> relics scale with how
//       far you got, generously, so no map ever needs replaying to fund the next
//   "there is no respec system"                         -> respec is free, always
//   "too many nodes just do the same thing"             -> every node changes
//       something a player can point at. No duplicate percentage padding.
//
// One function turns the saved node levels into the numbers the game reads, so
// there is exactly one place where a node's effect lives.

import { save } from './save.js';

export const BRANCHES = [
  { id: 'economy', name: 'LOGISTICS', colour: '#e8c33c' },
  { id: 'towers', name: 'ORDNANCE', colour: '#9ec8e8' },
  { id: 'abilities', name: 'AIR SUPPORT', colour: '#e08cff' },
  { id: 'base', name: 'FORTIFICATION', colour: '#8fdc5a' },
];

// cost is per level: cost[i] buys level i+1
export const TREE = [
  // ---- logistics
  { id: 'bounty', branch: 'economy', name: 'BOUNTY', max: 3, cost: [3, 6, 12],
    desc: (n) => `+${n * 25}% gold from every kill` },
  { id: 'funds', branch: 'economy', name: 'WAR CHEST', max: 3, cost: [2, 5, 10],
    desc: (n) => `start each map with +${n * 150} gold` },
  { id: 'salvage', branch: 'economy', name: 'SALVAGE', max: 2, cost: [4, 8],
    desc: (n) => `selling refunds ${60 + n * 15}% instead of 60%` },
  { id: 'dividend', branch: 'economy', name: 'RUSH DIVIDEND', max: 2, cost: [4, 9],
    desc: (n) => `rushing a wave pays ${1 + n}x the bonus` },

  // ---- ordnance
  { id: 'blades', branch: 'towers', name: 'BLADE ARSENAL', max: 3, cost: [3, 7, 14],
    desc: (n) => `+${n * 3} BLADES you may build` },
  { id: 'guns', branch: 'towers', name: 'GUN ARSENAL', max: 3, cost: [3, 7, 14],
    desc: (n) => `+${n * 3} MG NESTS you may build` },
  { id: 'optics', branch: 'towers', name: 'OPTICS', max: 2, cost: [6, 13],
    desc: (n) => `+${n * 2} BEAM and BOUNCE each` },
  { id: 'battery', branch: 'towers', name: 'BATTERY', max: 2, cost: [6, 13],
    desc: (n) => `+${n * 2} MORTARS you may build` },
  { id: 'overclock', branch: 'towers', name: 'OVERCLOCK', max: 3, cost: [5, 10, 20],
    desc: (n) => `+${n * 15}% turret damage` },
  { id: 'pierce', branch: 'towers', name: 'PIERCING', max: 3, cost: [6, 12, 24],
    desc: (n) => `+${n * 25}% orcs each weapon can hit per second` },
  { id: 'foundry', branch: 'towers', name: 'FOUNDRY', max: 2, cost: [5, 11],
    desc: (n) => `upgrades cost ${n * 20}% less` },

  // ---- air support
  { id: 'response', branch: 'abilities', name: 'RAPID RESPONSE', max: 3, cost: [4, 8, 16],
    desc: (n) => `ability cooldowns ${n * 18}% shorter` },
  { id: 'pattern', branch: 'abilities', name: 'WIDE PATTERN', max: 2, cost: [5, 11],
    desc: (n) => `airstrike drops ${n * 2} more bombs` },
  { id: 'fallout', branch: 'abilities', name: 'FALLOUT', max: 2, cost: [6, 12],
    desc: (n) => `nuke radius +${n * 25}%` },
  { id: 'orbital', branch: 'abilities', name: 'ORBITAL LASER', max: 1, cost: [16],
    desc: () => 'unlocks R: a sustained beam you sweep by hand' },

  // ---- fortification
  { id: 'fortify', branch: 'base', name: 'FORTIFY', max: 3, cost: [3, 7, 14],
    desc: (n) => `base HP +${n * 30}` },
  { id: 'shieldwall', branch: 'base', name: 'SHIELD WALL', max: 2, cost: [4, 9],
    desc: (n) => `ramparts have +${n * 80}% health` },
  { id: 'medic', branch: 'base', name: 'FIELD REPAIRS', max: 2, cost: [6, 13],
    desc: (n) => `recover ${n} base HP for every wave held` },
  { id: 'dilation', branch: 'base', name: 'TIME DILATION', max: 1, cost: [8],
    desc: () => 'unlocks 8x and 12x fast forward' },
  { id: 'relichunt', branch: 'base', name: 'RELIC HUNTERS', max: 2, cost: [7, 15],
    desc: (n) => `+${n * 25}% relics from every run` },
];

export const nodeById = (id) => TREE.find((n) => n.id === id);

// Relics for a finished run. Deliberately generous, and a loss still pays: the
// complaint about the original was being forced to grind maps you had already won.
export function relicsFor({ wave, kills, won, target }) {
  const base = wave * 3 + Math.floor(kills / 2000) + (won ? 25 : 0);
  const bonus = won && target ? Math.floor(target / 4) : 0;
  const mult = 1 + 0.25 * (save.nodeLevel('relichunt') ?? 0);
  return Math.max(1, Math.round((base + bonus) * mult));
}

// Everything the game reads. One place, so a node cannot drift out of sync.
export function effects() {
  const lv = (id) => save.nodeLevel(id) ?? 0;
  return {
    goldMult: 1 + 0.25 * lv('bounty'),
    startGold: 150 * lv('funds'),
    sellRefund: 0.6 + 0.15 * lv('salvage'),
    rushMult: 1 + lv('dividend'),

    capBonus: {
      blades: 3 * lv('blades'),
      gun: 3 * lv('guns'),
      beam: 2 * lv('optics'),
      bounce: 2 * lv('optics'),
      mortar: 2 * lv('battery'),
    },
    damageMult: 1 + 0.15 * lv('overclock'),
    hitsMult: 1 + 0.25 * lv('pierce'),
    upgradeCostMult: 1 - 0.2 * lv('foundry'),

    cooldownMult: 1 - 0.18 * lv('response'),
    strikeBombs: 2 * lv('pattern'),
    nukeRadius: 1 + 0.25 * lv('fallout'),
    orbital: lv('orbital') > 0,

    baseHp: 30 * lv('fortify'),
    rampartHp: 1 + 0.8 * lv('shieldwall'),
    repairPerWave: lv('medic'),
    fastSpeeds: lv('dilation') > 0,
  };
}
