// localStorage progress and settings. One key, one version, and every read is
// defensive: a corrupt or half-written save must never stop the game booting.

const KEY = 'orcflow.save.v1';

const DEFAULTS = {
  unlocked: 1,          // how many maps are available
  best: {},             // mapIndex -> highest wave reached
  cleared: {},          // mapIndex -> true once its target is held
  totalKills: 0,
  settings: {
    sfx: 0.7,
    music: 0.35,
    showBench: false,
    orcCap: 250000,
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
  isCleared(map) { return cache.cleared[map] === true; },
  isUnlocked(map) { return map < cache.unlocked; },

  // Called when a run ends, win or lose.
  recordRun({ map, wave, won, kills, mapCount }) {
    cache.best[map] = Math.max(cache.best[map] ?? 0, wave);
    cache.totalKills += kills;
    if (won) {
      cache.cleared[map] = true;
      cache.unlocked = Math.min(mapCount, Math.max(cache.unlocked, map + 2));
    }
    this.flush();
  },

  wipe() {
    cache = structuredClone(DEFAULTS);
    this.flush();
  },
};
