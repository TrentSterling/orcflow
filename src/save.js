// localStorage progress and settings. One key, one version, and every read is
// defensive: a corrupt or half-written save must never stop the game booting.

const KEY = 'orcflow.save.v1';

const DEFAULTS = {
  unlocked: 1,          // how many maps are available
  best: {},             // mapIndex -> highest wave reached
  cleared: {},          // mapIndex -> true once its target is held
  totalKills: 0,
  relics: 0,                 // meta currency, earned every run win or lose
  spent: 0,                  // relics currently invested, refunded on respec
  nodes: {},                 // tree node id -> level
  endlessBest: {},            // mapIndex -> best wave in endless
  settings: {
    sfx: 0.7,
    music: 0.35,
    showBench: false,
    orcCap: 500000,
    speed: 1,
  },
};

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const parsed = JSON.parse(raw);
    return {
      ...structuredClone(DEFAULTS),
      ...parsed,
      settings: { ...DEFAULTS.settings, ...(parsed.settings ?? {}) },
      best: parsed.best ?? {},
      cleared: parsed.cleared ?? {},
      nodes: parsed.nodes ?? {},
      endlessBest: parsed.endlessBest ?? {},
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

let cache = read();

export const save = {
  get data() { return cache; },
  get settings() { return cache.settings; },

  flush() {
    try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch {}
  },

  setSetting(key, value) {
    cache.settings[key] = value;
    this.flush();
  },

  bestWave(map) { return cache.best[map] ?? 0; },
  endlessBest(map) { return cache.endlessBest[map] ?? 0; },

  // ---- meta tree ----------------------------------------------------------
  get relics() { return cache.relics; },
  nodeLevel(id) { return cache.nodes[id] ?? 0; },

  addRelics(n) { cache.relics += n; this.flush(); },

  buyNode(id, cost) {
    if (cache.relics < cost) return false;
    cache.relics -= cost;
    cache.spent += cost;
    cache.nodes[id] = (cache.nodes[id] ?? 0) + 1;
    this.flush();
    return true;
  },

  // Free, always. The single loudest missing feature in the game this one nods to.
  respec() {
    cache.relics += cache.spent;
    cache.spent = 0;
    cache.nodes = {};
    this.flush();
  },

  recordEndless(map, wave) {
    cache.endlessBest[map] = Math.max(cache.endlessBest[map] ?? 0, wave);
    this.flush();
  },
  isCleared(map) { return cache.cleared[map] === true; },
  // Every map is playable from the start. Progression is what you have CLEARED
  // and your best wave, not a gate that a single hard map can slam shut.
  isUnlocked() { return true; },

  // How far you have to get on a map before the next one opens. Requiring a full
  // clear meant one hard map could wall the whole campaign shut.
  unlockAt(target) { return Math.max(1, Math.ceil(target * 0.6)); },

  // Called when a run ends, win or lose.
  recordRun({ map, wave, won, kills, mapCount, target }) {
    cache.best[map] = Math.max(cache.best[map] ?? 0, wave);
    cache.totalKills += kills;
    if (won) cache.cleared[map] = true;
    if (won || wave >= this.unlockAt(target ?? 99)) {
      cache.unlocked = Math.min(mapCount, Math.max(cache.unlocked, map + 2));
    }
    this.flush();
  },

  wipe() {
    cache = structuredClone(DEFAULTS);
    this.flush();
  },
};
