// Main menu, map select, settings, pause and results. Built in JS so index.html
// stays readable; styling lives in index.html.
//
// Map selection navigates (`?map=N`) rather than tearing the sim down and
// rebuilding it. A fresh load per run means no state can leak between attempts,
// and the menu sits over a live attract-mode game so the title screen is never
// a static picture.

import { MAPS } from './maps.js';
import { TREE, BRANCHES } from './meta.js';
import { save } from './save.js';
import { sfx } from './audio.js';

const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

export class Menu {
  constructor({ onStart, onResume, onRestart, onQuit, onSetting }) {
    this.cb = { onStart, onResume, onRestart, onQuit, onSetting };
    this.root = el('div', 'screen');
    this.root.id = 'menu';
    document.body.appendChild(this.root);

    this.pause = el('div', 'screen');
    this.pause.id = 'pausescreen';
    document.body.appendChild(this.pause);

    this.buildMain();
    this.buildPause();
  }

  // ---- main menu ------------------------------------------------------------
  buildMain() {
    const wrap = el('div', 'sheet');
    wrap.appendChild(el('h1', 'title', 'ORCFLOW'));
    wrap.appendChild(el('div', 'tagline', 'sir, we have a flow field'));

    const stats = el('div', 'menustats');
    const total = save.data.totalKills;
    stats.innerHTML = total > 0
      ? `${total.toLocaleString()} orcs killed all time`
      : 'a hundred thousand orcs, all of them on the GPU';
    wrap.appendChild(stats);

    this.mapList = el('div', 'maplist');
    wrap.appendChild(this.mapList);

    const row = el('div', 'menurow');
    const treeBtn = el('button', 'mbtn', 'UPGRADES');
    treeBtn.onclick = () => { sfx.click(); this.showTree(); };
    const settingsBtn = el('button', 'mbtn', 'SETTINGS');
    settingsBtn.onclick = () => { sfx.click(); this.showSettings(); };
    const aboutBtn = el('button', 'mbtn', 'ABOUT');
    aboutBtn.onclick = () => {
      sfx.click();
      document.getElementById('about').classList.toggle('show');
    };
    row.append(treeBtn, settingsBtn, aboutBtn);
    wrap.appendChild(row);

    wrap.appendChild(el('div', 'menufoot',
      'A tech homage to <b>Sir, We Have an Orc Problem</b> by <b>Mumpitz Games</b>. '
      + '<a href="https://store.steampowered.com/search/?term=Sir%2C+We+Have+an+Orc+Problem" target="_blank" rel="noopener">Go play the real one.</a>'));

    this.settingsSheet = this.buildSettings();
    this.treeSheet = this.buildTree();
    this.root.append(wrap, this.settingsSheet, this.treeSheet);
    this.mainSheet = wrap;
    this.refreshMaps();
  }

  refreshMaps() {
    this.mapList.replaceChildren();
    MAPS.forEach((map, i) => {
      const unlocked = save.isUnlocked(i);
      const card = el('button', `mapcard${unlocked ? '' : ' locked'}`);
      const best = save.bestWave(i);
      const note = save.isCleared(i) ? 'CLEARED' : best ? `best wave ${best}` : 'not yet held';
      card.innerHTML = `
        <div class="mi">${String(i + 1).padStart(2, '0')}</div>
        <div class="mn">${map.name}</div>
        <div class="mw">${map.waves} waves${best ? ` &middot; best ${best}` : ''}</div>
        <div class="mb">${note}</div>`;
      card.disabled = !unlocked;
      card.onclick = () => { sfx.click(); this.cb.onStart(i); };
      this.mapList.appendChild(card);
    });
  }

  // ---- settings -------------------------------------------------------------
  buildSettings() {
    const sheet = el('div', 'sheet hidden');
    sheet.appendChild(el('h2', 'title2', 'SETTINGS'));

    const slider = (label, key, min, max, step, fmt) => {
      const row = el('label', 'srow');
      const out = el('span', 'sval', fmt(save.settings[key]));
      const input = el('input');
      input.type = 'range';
      input.min = min; input.max = max; input.step = step;
      input.value = save.settings[key];
      input.oninput = () => {
        const v = Number(input.value);
        out.textContent = fmt(v);
        save.setSetting(key, v);
        this.cb.onSetting(key, v);
      };
      row.append(el('span', 'slabel', label), input, out);
      return row;
    };

    sheet.appendChild(slider('Sound', 'sfx', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`));
    sheet.appendChild(slider('Music', 'music', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`));

    const capRow = el('label', 'srow');
    const capSel = el('select');
    for (const n of [100000, 250000, 500000, 1000000, 2000000]) {
      const o = el('option', null, n.toLocaleString());
      o.value = String(n);
      if (save.settings.orcCap === n) o.selected = true;
      capSel.appendChild(o);
    }
    capSel.onchange = () => {
      save.setSetting('orcCap', Number(capSel.value));
      this.cb.onSetting('orcCap', Number(capSel.value));
    };
    capRow.append(el('span', 'slabel', 'Orc capacity'), capSel, el('span', 'sval', 'next run'));
    sheet.appendChild(capRow);

    const benchRow = el('label', 'srow');
    const benchBox = el('input');
    benchBox.type = 'checkbox';
    benchBox.checked = save.settings.showBench;
    benchBox.onchange = () => {
      save.setSetting('showBench', benchBox.checked);
      this.cb.onSetting('showBench', benchBox.checked);
    };
    benchRow.append(el('span', 'slabel', 'Benchmark panel'), benchBox, el('span', 'sval', ''));
    sheet.appendChild(benchRow);

    const row = el('div', 'menurow');
    const back = el('button', 'mbtn', 'BACK');
    back.onclick = () => { sfx.click(); this.showMain(); };
    const wipe = el('button', 'mbtn danger', 'WIPE PROGRESS');
    wipe.onclick = () => {
      if (wipe.dataset.armed) {
        save.wipe();
        wipe.textContent = 'WIPED';
        delete wipe.dataset.armed;
        this.refreshMaps();
        return;
      }
      wipe.dataset.armed = '1';
      wipe.textContent = 'REALLY WIPE?';
    };
    row.append(back, wipe);
    sheet.appendChild(row);
    return sheet;
  }

  showSettings() {
    this.mainSheet.classList.add('hidden');
    this.treeSheet.classList.add('hidden');
    this.settingsSheet.classList.remove('hidden');
  }

  showTree() {
    this.mainSheet.classList.add('hidden');
    this.settingsSheet.classList.add('hidden');
    this.treeSheet.classList.remove('hidden');
    this.refreshTree();
  }

  showMain() {
    this.settingsSheet.classList.add('hidden');
    this.treeSheet.classList.add('hidden');
    this.mainSheet.classList.remove('hidden');
    this.refreshMaps();
  }

  // ---- upgrade tree ---------------------------------------------------------
  // Flat branches rather than a node graph on purpose. The game this nods to has
  // 50+ nodes and reviewers said most of them repeat; this is 20 nodes that each
  // change something you can point at, all visible at once, no scrolling.
  buildTree() {
    const sheet = el('div', 'sheet wide hidden');
    const head = el('div', 'treehead');
    head.appendChild(el('h2', 'title2', 'UPGRADES'));
    this.relicCount = el('div', 'relics', '');
    head.appendChild(this.relicCount);
    sheet.appendChild(head);

    sheet.appendChild(el('p', 'treenote',
      'Relics come from every run, won or lost. Respec is free, so experiment.'));

    this.treeBody = el('div', 'treebody');
    sheet.appendChild(this.treeBody);

    const row = el('div', 'menurow');
    const back = el('button', 'mbtn', 'BACK');
    back.onclick = () => { sfx.click(); this.showMain(); };
    const respec = el('button', 'mbtn', 'RESPEC (FREE)');
    respec.onclick = () => {
      sfx.click();
      save.respec();
      this.cb.onRespec?.();
      this.refreshTree();
    };
    row.append(back, respec);
    sheet.appendChild(row);
    return sheet;
  }

  refreshTree() {
    this.relicCount.innerHTML = `<b>${save.relics}</b> relics`;
    this.treeBody.replaceChildren();

    for (const branch of BRANCHES) {
      const col = el('div', 'branch');
      const h = el('div', 'branchname', branch.name);
      h.style.color = branch.colour;
      col.appendChild(h);

      for (const node of TREE.filter((n) => n.branch === branch.id)) {
        const lvl = save.nodeLevel(node.id);
        const maxed = lvl >= node.max;
        const cost = maxed ? 0 : node.cost[lvl];
        const afford = !maxed && save.relics >= cost;

        const card = el('button', `node${maxed ? ' maxed' : ''}${afford ? ' afford' : ''}`);
        card.innerHTML = `
          <div class="nrow"><span class="nname">${node.name}</span>
            <span class="nlvl">${lvl}/${node.max}</span></div>
          <div class="ndesc">${node.desc(Math.max(1, lvl || 1))}</div>
          <div class="ncost">${maxed ? 'MAXED' : `${cost} relics`}</div>`;
        card.disabled = maxed || !afford;
        card.onclick = () => {
          if (!save.buyNode(node.id, cost)) return;
          sfx.place();
          this.cb.onRespec?.();
          this.refreshTree();
        };
        col.appendChild(card);
      }
      this.treeBody.appendChild(col);
    }
  }

  show() { this.root.classList.add('show'); this.refreshMaps(); }
  hide() { this.root.classList.remove('show'); }

  // ---- pause ----------------------------------------------------------------
  buildPause() {
    const sheet = el('div', 'sheet');
    sheet.appendChild(el('h2', 'title2', 'PAUSED'));
    const row = el('div', 'menucol');
    const resume = el('button', 'mbtn', 'RESUME');
    resume.onclick = () => { sfx.click(); this.cb.onResume(); };
    const restart = el('button', 'mbtn', 'RESTART MAP');
    restart.onclick = () => { sfx.click(); this.cb.onRestart(); };
    const quit = el('button', 'mbtn', 'MAIN MENU');
    quit.onclick = () => { sfx.click(); this.cb.onQuit(); };
    row.append(resume, restart, quit);
    sheet.appendChild(row);
    this.pause.appendChild(sheet);
  }

  showPause() { this.pause.classList.add('show'); }
  hidePause() { this.pause.classList.remove('show'); }
}
