// Thin DOM layer. The HUD only ever reads state that the CPU already has:
// numbers that came back from an async counter snapshot, never a GPU query.

import { BUILDS } from './config.js';

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor({ onSelect, onStress, onFlood, onRestart }) {
    this.el = {
      hud: $('hud'), boot: $('boot'), bootmsg: $('bootmsg'),
      hpfill: $('hpfill'), hptext: $('hptext'),
      gold: $('c-gold'), orcs: $('c-orcs'), kills: $('c-kills'),
      waveN: $('w-n'), waveS: $('w-s'), waveMap: $('w-map'),
      fps: $('b-fps'), ms: $('b-ms'), compute: $('b-compute'), render: $('b-render'),
      alive: $('b-alive'), spawned: $('b-spawned'), cap: $('b-cap'),
      bar: $('bar'), toast: $('toast'), over: $('over'), overSub: $('over-sub'),
    };

    this.slots = BUILDS.map((b, i) => {
      const el = document.createElement('div');
      el.className = 'slot';
      el.innerHTML = `<div class="k">${b.key}</div><div class="n">${b.name}</div><div class="c">${b.cost}g</div>`;
      el.addEventListener('click', () => onSelect(i));
      this.el.bar.appendChild(el);
      return el;
    });

    const about = $('about');
    $('aboutbtn').addEventListener('click', () => about.classList.toggle('show'));

    $('b-stress').addEventListener('click', onStress);
    $('b-flood').addEventListener('click', onFlood);
    $('over-btn').addEventListener('click', onRestart);
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

  gameOver(sub) {
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

    e.waveN.textContent = s.wave;
    e.waveS.textContent = s.waveText;
    e.waveMap.textContent = s.mapName;

    e.fps.textContent = s.fps.toFixed(0);
    e.ms.textContent = `${s.ms.toFixed(1)} ms`;
    e.compute.textContent = s.computeMs != null ? `${s.computeMs.toFixed(2)} ms` : 'n/a';
    e.render.textContent = s.renderMs != null ? `${s.renderMs.toFixed(2)} ms` : 'n/a';
    e.alive.textContent = fmt(s.alive);
    e.spawned.textContent = fmt(s.spawned);
    e.cap.textContent = s.recycling ? `${fmt(s.cap)} ↻` : fmt(s.cap);
    e.cap.title = s.recycling ? 'at capacity: new orcs overwrite the oldest slots' : '';

    this.slots.forEach((el, i) => {
      el.classList.toggle('on', i === s.selected);
      el.classList.toggle('poor', BUILDS[i].cost > s.gold);
    });
  }
}

function fmt(n) {
  n = Math.round(n);
  if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
  if (n >= 10000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}
