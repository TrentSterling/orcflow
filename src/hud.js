// Thin DOM layer. The HUD only ever reads state that the CPU already has:
// numbers that came back from an async counter snapshot, never a GPU query.

import { BUILDS, ABILITIES } from './config.js';

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor({ onSelect, onStress, onFlood, onSpeed, onMute }) {
    this.el = {
      hud: $('hud'), boot: $('boot'), bootmsg: $('bootmsg'),
      hpfill: $('hpfill'), hptext: $('hptext'),
      gold: $('c-gold'), orcs: $('c-orcs'), kills: $('c-kills'), towers: $('c-towers'),
      waveN: $('w-n'), waveS: $('w-s'), waveMap: $('w-map'),
      speed: $('w-speed'), banner: $('banner'),
      fps: $('b-fps'), ms: $('b-ms'), compute: $('b-compute'), render: $('b-render'),
      alive: $('b-alive'), spawned: $('b-spawned'), cap: $('b-cap'), stalls: $('b-stalls'),
      bar: $('bar'), toast: $('toast'), over: $('over'),
      overTitle: $('over-title'), overSub: $('over-sub'),
    };

    this.slots = BUILDS.map((b, i) => {
      const el = document.createElement('div');
      el.className = 'slot';
      el.innerHTML = `<div class="k">${b.key}</div><div class="n">${b.name}</div>`
        + `<div class="c">${b.cost}g</div>`
        + (b.limit ? '<div class="lim"></div>' : '');
      el.addEventListener('click', () => onSelect(i));
      this.el.bar.appendChild(el);
      return el;
    });

    // ability slots live at the end of the hotbar
    this.abilitySlots = ABILITIES.map((a) => {
      const el = document.createElement('div');
      el.className = 'slot ability';
      el.innerHTML = `<div class="k">${a.key.toUpperCase()}</div><div class="n">${a.name}</div><div class="c">ready</div>`;
      this.el.bar.appendChild(el);
      return el;
    });

    const about = $('about');
    $('aboutbtn').addEventListener('click', () => about.classList.toggle('show'));

    $('w-speed').addEventListener('click', () => onSpeed?.());
    this.el.mute = $('w-mute');
    this.el.mute.addEventListener('click', () => onMute?.());
    $('b-stress').addEventListener('click', onStress);
    $('b-flood').addEventListener('click', onFlood);
    this._toastTimer = 0;
  }

  ready() {
    this.el.boot.hidden = true;
    this.el.hud.hidden = false;
  }

  fail(msg) {
    this.el.bootmsg.innerHTML = msg;
  }

  toast(msg) {
    this.el.toast.textContent = msg;
    this.el.toast.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.el.toast.classList.remove('show'), 1400);
  }

  gameOver(sub, title = 'OVERRUN') {
    this.el.overTitle.textContent = title;
    this.el.overTitle.style.color = title === 'OVERRUN' ? '' : 'var(--good)';
    this.el.overSub.textContent = sub;
    this.el.over.classList.add('show');
  }

  update(s) {
    const e = this.el;
    e.hpfill.style.transform = `scaleX(${Math.max(0, Math.min(1, s.hp / s.hpMax))})`;
    e.hptext.textContent = `${Math.max(0, Math.ceil(s.hp))} / ${s.hpMax}`;
    e.gold.textContent = fmt(s.gold);
    e.orcs.textContent = fmt(s.alive);
    e.kills.textContent = fmt(s.kills);
    e.towers.textContent = String(s.towers);

    e.waveN.textContent = s.wave;
    e.waveS.textContent = s.waveText;
    e.waveMap.textContent = s.mapName;
    e.speed.textContent = `${s.speed}x`;
    e.speed.classList.toggle('fast', s.speed > 1);
    if (e.mute) {
      const label = s.muted ? 'MUTED' : 'SOUND ON';
      if (e.mute.textContent !== label) e.mute.textContent = label;
      e.mute.classList.toggle('fast', !s.muted);
    }

    const phase = s.banner ?? '';
    if (phase !== this._banner) {
      this._banner = phase;
      e.banner.innerHTML = phase;
      e.banner.classList.toggle('show', phase !== '');
    }

    e.fps.textContent = s.fps.toFixed(0);
    e.ms.textContent = `${s.ms.toFixed(1)} ms`;
    e.compute.textContent = s.computeMs != null ? `${s.computeMs.toFixed(2)} ms` : 'n/a';
    e.render.textContent = s.renderMs != null ? `${s.renderMs.toFixed(2)} ms` : 'n/a';
    e.alive.textContent = fmt(s.alive);
    e.spawned.textContent = fmt(s.spawned);
    // orc-frames that needed the goal-ward guarantee: near zero when the crowd
    // physics is healthy, spiking the moment something stalls
    e.stalls.textContent = fmt(s.stalls ?? 0);
    e.stalls.style.color = (s.stalls ?? 0) > 400 ? '#e2564a' : '';
    e.cap.textContent = s.recycling ? `${fmt(s.cap)} ↻` : fmt(s.cap);
    e.cap.title = s.recycling ? 'at capacity: new orcs overwrite the oldest slots' : '';

    this.abilitySlots.forEach((el, i) => {
      const cd = s.cooldowns?.[i] ?? 0;
      el.classList.toggle('poor', cd > 0);
      const c = el.querySelector('.c');
      const text = cd > 0 ? `${cd.toFixed(0)}s` : 'ready';
      if (c.textContent !== text) c.textContent = text;
    });

    // Prices escalate per purchase, so the hotbar shows the live cost.
    this.slots.forEach((el, i) => {
      el.classList.toggle('on', i === s.selected);
      const price = s.costs?.[i] ?? BUILDS[i].cost;
      el.classList.toggle('poor', price > s.gold);
      const c = el.querySelector('.c');
      if (c.dataset.price !== String(price)) {
        c.dataset.price = String(price);
        c.textContent = `${fmt(price)}g`;
      }
      const lim = el.querySelector('.lim');
      if (lim && s.built) {
        const used = s.built[BUILDS[i].id] ?? 0;
        const max = BUILDS[i].limit;
        const text = `${used}/${max}`;
        if (lim.textContent !== text) lim.textContent = text;
        lim.classList.toggle('full', used >= max);
      }
    });
  }
}

function fmt(n) {
  n = Math.round(n);
  if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
  if (n >= 10000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}
