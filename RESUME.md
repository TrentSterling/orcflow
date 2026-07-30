# ORCFLOW resume notes

Cold-start state as of **2026-07-29** (built in one session). Read `DESIGN.md` for why
anything is shaped the way it is, this file is for picking the work back up.

## Where it lives

| | |
|---|---|
| local | `C:\trontstack\orcflow` (own git repo, not part of the monorepo) |
| repo | `github.com/TrentSterling/orcflow`, public, MIT |
| live | `https://tront.xyz/orcflow/`, Pages from **repo root on `main`** (not `docs/`, the game *is* the site) |
| deploy | `git push` and Pages rebuilds. No build step, nothing to compile |

## Run and check

```
node serve.mjs                                   # http://localhost:8099/
node --test test/field.test.mjs                  # 8 tests, all pure JS field logic
node tools/smoke.mjs "http://localhost:8099/?bench=1&perf=1" 12
```

`tools/smoke.mjs` boots a real browser over CDP, prints console output, exceptions and a
state heartbeat, and screenshots to `shots/` (gitignored). It found most of the bugs in
this project. Two rules baked into it: it opens **its own tab** and never adopts one that
was already open, and it never does a blanket `taskkill chrome.exe`.

Benchmark params: `?orcs=N ?spawn=N ?bench=1 ?rate=N ?autobuild=1 ?ramparts=N ?perf=1 ?map=N ?wave=1`

## Current numbers

RTX 5070 Ti, Chrome, 1600x900: **~95,000 orcs alive, live sim, locked 60 fps**, p50 16.7 ms,
compute 0.04–0.3 ms, render 0.1–0.6 ms. Vsync bound, not GPU bound. Capacity default 250k,
`?orcs=` accepts up to 2M if you want to find the real ceiling. Nobody has found it yet.

## What works

- Flow-field navigation with live rebake: paint a rampart, the horde reroutes mid-run
- Crowd separation via an atomic density grid (the nose-to-tail river look)
- Four weapons: blades disc, beam that locks onto the thickest crowd, beam that bounces off
  rock, mortar that shells the thickest crowd
- Waves with escalating headcount, gold from kills, base HP from leaks, lose state
- Corpses that darken as they dry and double as the blood system
- 4 maps, ASCII authored, `M` cycles
- Sandbox mode so benchmark floods cannot end a run
- HUD with real WebGPU timestamp queries

## Known rough edges

1. **`alive` is derived**, not counted: `spawned - kills - leaks`, clamped to capacity. Orcs
   overwritten by the spawn ring never report a death, so it drifts slightly while recycling.
2. **No audio at all.** The GPU event ring buffer described in `DESIGN.md` is the intended
   path: deaths and blasts push position + type, the CPU reads it async and plays sounds.
3. **No sell or undo.** Ramparts and turrets are permanent once placed.
4. **No upgrades**, no economy depth beyond build costs.
5. **Density snapshot is ~10 frames stale**, so beams and mortars aim slightly behind fast
   crowds. Noticeable with runners, fine with grunts.
6. **Orcs hug corridor edges.** Best-neighbour flow plus density push does that. It looks
   right in corridors, slightly odd in wide-open rooms.
7. **One portal per map** authored, though `field.spawns` is a list and waves already cycle it.
8. **Corpses hold their slot** for `CORPSE_FADE` seconds, so under heavy spawn rates they get
   recycled before they finish fading.
9. **Desktop WebGPU only.** No WebGL fallback, phones get a banner. Automated smoke only
   drives Chrome; Firefox 141+ is verified by hand.
10. **No menu, no start/finish framing.** It drops you straight into a map.

## Next steps, roughly ranked

1. **Tracer rounds as a second GPU particle system.** The reference game's machine-gun
   streams are thousands of tiny projectiles; same buffer + compute pattern as the orcs, with
   segment collision against the density grid. Biggest visual payoff left.
2. **GPU event ring buffer** for audio and floating damage numbers. Design is written in
   `DESIGN.md`, nothing exists yet. Unlocks sound, which is the single largest missing sense.
3. **Sell / undo, and turret upgrades.** Cheap to add, immediately makes it feel like a game
   rather than a sandbox.
4. **Biome palettes.** The reference late game goes purple-crystal and teal-water; `art.js`
   and `ground.js` already take all colour from `PALETTE`, so this is a table swap.
5. **Multi-portal maps**, two fronts at once. Code path exists, just needs authoring.
6. **Menu, start, finish, sfx, music.** The actual challenge Tacker put out in #spicy-dev, and
   the honest gap between this and a finished thing.
7. **Orc variety**: armour and resistances are one unused field in the `att` buffer away.

## Traps to not fall back into

Full detail in `DESIGN.md`, short version:

- Dijkstra costs must be **Float64**. Float32 rounding of `sqrt(2)` steps silently truncated
  the flood fill to a third of the map.
- Every rock cell needs an **escape vector**, or anything a rampart lands on is stuck forever.
  The sim also has to skip its own collision rejection while an orc is inside rock.
- Ramparts are **half an authored block** (`RAMPART = 2` cells). A block-sized rampart can only
  seal a 4-cell corridor, never narrow it, which reads to the player as "ramparts don't work".
- Damage shape radius must match the art. A 15-unit kill disc behind a 4-unit sprite reads as
  a bug even though it is working.
- Wall rows in authored maps must open on **one side only**, or the map has a straight shortcut.
- Chrome stops `requestAnimationFrame` on an **occluded window**: zero frames, no error, looks
  exactly like a hang. The smoke tool passes the occlusion flags.
- `InstancedMesh` will collapse everything to the origin (instance matrix), use a plain `Mesh`
  with an `InstancedBufferGeometry`.
- three.js is **vendored** in `vendor/` at r0.185.1 on purpose. Upgrading means re-checking the
  TSL surface (`instancedArray`, `toAtomic`, `atomicLoad/Store`, `Loop`, `toAttribute`).

## The framing, if this ever gets shown off again

It is a tech homage, credited in three places (boot screen, ABOUT panel, README). The point is
that the *tech* behind a 100k-enemy horde game is not a moat in 2026, and that finishing a game
still is. Mumpitz Games did the hard part. Never present this as a competing product, and keep
the link to their Steam page in place.
