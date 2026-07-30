// All sound is synthesised at runtime with WebAudio: no files, same rule as the
// textures. Browsers block audio until a gesture, so the context is created lazily
// on the first click or keypress.
//
// The crowd is the interesting case. Tens of thousands of orcs die per wave, so
// deaths are not played individually: kills per second drive the density of a
// rate-limited squelch layer, which reads as a crowd rather than a machine gun.

let ctx = null;
let master = null;
let sfxGain = null;
let musicGain = null;
let musicTimer = null;
let started = false;

const settings = { sfx: 0.7, music: 0.35 };
const state = { killBudget: 0, lastSquelch: 0, lastShot: 0 };

export function configureAudio({ sfx, music }) {
  if (sfx != null) settings.sfx = sfx;
  if (music != null) settings.music = music;
  if (sfxGain) sfxGain.gain.value = settings.sfx;
  if (musicGain) musicGain.gain.value = settings.music * 0.5;
}

export function startAudio() {
  if (started) return;
  const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!AC) return;
  started = true;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);
  sfxGain = ctx.createGain();
  sfxGain.gain.value = settings.sfx;
  sfxGain.connect(master);
  musicGain = ctx.createGain();
  musicGain.gain.value = settings.music * 0.5;
  musicGain.connect(master);
  startMusic();
}

export function resumeAudio() {
  if (ctx?.state === 'suspended') ctx.resume();
}

const now = () => ctx.currentTime;

function env(node, { attack = 0.005, decay = 0.12, peak = 1 }) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now());
  g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), now() + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, now() + attack + decay);
  node.connect(g);
  return g;
}

function tone({ freq = 440, type = 'sine', decay = 0.12, peak = 0.5, detune = 0, slideTo = null, dest = null }) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, now());
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), now() + decay);
  osc.detune.value = detune;
  const g = env(osc, { decay, peak });
  g.connect(dest ?? sfxGain);
  osc.start();
  osc.stop(now() + decay + 0.05);
}

function noiseBurst({ decay = 0.2, peak = 0.4, lowpass = 1800, highpass = 0 }) {
  if (!ctx) return;
  const len = Math.max(1, Math.floor(ctx.sampleRate * decay));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  let node = src;
  if (highpass) {
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = highpass;
    node.connect(hp); node = hp;
  }
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = lowpass;
  node.connect(lp);
  const g = env(lp, { decay, peak });
  g.connect(sfxGain);
  src.start();
}

// ---- one-shots ---------------------------------------------------------------

export const sfx = {
  click() { tone({ freq: 520, type: 'square', decay: 0.05, peak: 0.16 }); },

  place() {
    tone({ freq: 180, type: 'square', decay: 0.09, peak: 0.22, slideTo: 320 });
    noiseBurst({ decay: 0.16, peak: 0.18, lowpass: 2600 });
  },

  denied() { tone({ freq: 150, type: 'sawtooth', decay: 0.16, peak: 0.16, slideTo: 90 }); },

  waveHorn() {
    // two detuned saws sliding up: a war horn, not a fanfare
    tone({ freq: 110, type: 'sawtooth', decay: 1.1, peak: 0.20, slideTo: 165 });
    tone({ freq: 111, type: 'sawtooth', decay: 1.1, peak: 0.16, detune: 12, slideTo: 164 });
  },

  blast() {
    noiseBurst({ decay: 0.5, peak: 0.5, lowpass: 900 });
    tone({ freq: 90, type: 'sine', decay: 0.4, peak: 0.4, slideTo: 34 });
  },

  leak() {
    tone({ freq: 70, type: 'square', decay: 0.32, peak: 0.4, slideTo: 44 });
    noiseBurst({ decay: 0.22, peak: 0.2, lowpass: 500 });
  },

  win() {
    [0, 4, 7, 12].forEach((semi, i) => {
      setTimeout(() => tone({ freq: 220 * Math.pow(2, semi / 12), type: 'triangle', decay: 0.5, peak: 0.28 }), i * 130);
    });
  },

  lose() {
    [0, -3, -7, -12].forEach((semi, i) => {
      setTimeout(() => tone({ freq: 220 * Math.pow(2, semi / 12), type: 'sawtooth', decay: 0.7, peak: 0.22 }), i * 200);
    });
  },

  // Called every frame with how many orcs died. Deaths are a texture, not events.
  crowdKills(count, time) {
    if (!ctx || count <= 0) return;
    state.killBudget += count;
    const gap = state.killBudget > 60 ? 0.045 : 0.11;
    if (time - state.lastSquelch < gap) return;
    state.lastSquelch = time;
    const heavy = Math.min(1, state.killBudget / 80);
    state.killBudget = 0;
    noiseBurst({
      decay: 0.05 + heavy * 0.09,
      peak: 0.05 + heavy * 0.16,
      lowpass: 700 + Math.random() * 900,
      highpass: 200,
    });
  },

  // Turret fire, also rate limited: 24 turrets firing individually is noise.
  turretFire(activeTurrets, time) {
    if (!ctx || activeTurrets <= 0) return;
    if (time - state.lastShot < 0.075) return;
    state.lastShot = time;
    tone({
      freq: 900 + Math.random() * 500,
      type: 'square',
      decay: 0.035,
      peak: 0.03 + Math.min(0.05, activeTurrets * 0.003),
    });
  },
};

// ---- music bed ---------------------------------------------------------------
// Slow minor drone plus a sparse arpeggio. Enough to feel scored, quiet enough
// to leave alone for an hour.

function startMusic() {
  if (!ctx) return;
  const root = 55;                          // A1
  const drone = ctx.createOscillator();
  drone.type = 'sawtooth';
  drone.frequency.value = root;
  const droneFilter = ctx.createBiquadFilter();
  droneFilter.type = 'lowpass';
  droneFilter.frequency.value = 220;
  const droneGain = ctx.createGain();
  droneGain.gain.value = 0.16;
  drone.connect(droneFilter); droneFilter.connect(droneGain); droneGain.connect(musicGain);
  drone.start();

  const fifth = ctx.createOscillator();
  fifth.type = 'triangle';
  fifth.frequency.value = root * 1.5;
  const fifthGain = ctx.createGain();
  fifthGain.gain.value = 0.05;
  fifth.connect(fifthGain); fifthGain.connect(musicGain);
  fifth.start();

  const scale = [0, 3, 5, 7, 10];           // minor pentatonic
  let step = 0;
  musicTimer = setInterval(() => {
    if (!ctx || musicGain.gain.value <= 0.001) return;
    const semi = scale[(step * 3) % scale.length] + (step % 8 === 0 ? 12 : 0);
    tone({
      freq: root * 4 * Math.pow(2, semi / 12),
      type: 'triangle',
      decay: 0.9,
      peak: 0.06,
      dest: musicGain,
    });
    step++;
  }, 1200);
}

export function stopAudio() {
  if (musicTimer) clearInterval(musicTimer);
}
