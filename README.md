# ORCFLOW

### *sir, we have a flow field* — v1.0.0

GPU tower defense in Three.js. Every orc lives in a WebGPU storage buffer for its
whole life: navigation, crowd separation, damage, death and recycling all happen
in compute shaders. The CPU sets uniforms, bakes flow fields, and draws.

**Play it: [tront.xyz/orcflow](https://tront.xyz/orcflow/)** (needs WebGPU)

## Credits, and what this is

Inspired by **[Sir, We Have an Orc Problem](https://store.steampowered.com/search/?term=Sir%2C+We+Have+an+Orc+Problem)**
by **Mumpitz Games** (Laurin + Stephan). Go buy theirs, they did the hard part.

This is a clean-room tech homage, not a clone for sale. No code, art or assets of
theirs are used: every texture is drawn procedurally on a canvas at boot, every
sound is synthesised with WebAudio, the maps are mine, the whole thing is MIT and
earns nothing. Not affiliated with or endorsed by Mumpitz Games.

It exists to answer one question. Is the tech behind a 100k-enemy horde game a
moat in 2026? No. Finishing a game still is, so this one got finished.

## The game

Twelve maps, each with its own wave target. Progress, best waves and settings
persist in localStorage.

| # | map | waves | shape |
|---|---|---|---|
| 1 | THE SIEVE | 13 | staggered pillar field, the horde braids through it |
| 2 | THE FORK | 12 | two lanes around a central block |
| 3 | THE SNAKE | 14 | one long serpentine corridor |
| 4 | PILLARS | 13 | open bowl, pillar lattice |
| 5 | CHICANE | 12 | staggered walls, wide pockets |
| 6 | THE COMB | 12 | vertical fingers, ten parallel lanes |
| 7 | THE FUNNEL | 12 | diagonal walls narrowing to one choke |
| 8 | TWIN GATES | 13 | two portals, two fronts at once |
| 9 | ISLANDS | 13 | scattered platforms, open water between |
| 10 | THE BASIN | 14 | walled bowl around the base, two gates |
| 11 | THE GAUNTLET | 14 | long switchbacks with rooms |
| 12 | THE SPIRAL | 13 | wound inward to a centre base |

Every map is playable from the start: progression is which ones you have CLEARED
and your best wave on each, not a gate one hard map can slam shut.

**Turrets are built on the rock**, on the plateaus above the trenches the orcs
walk. Placement can therefore never block a path, and a rampart does double duty:
it funnels the horde *and* raises a new firing platform. Nothing may be built
inside the ring around a portal, and a kill pays its full bounty at your doorstep
but only a fraction at the portal, so camping the spawn is unprofitable rather
than merely illegal.

Five builds, and every copy you buy costs more than the last:

- **RAMPART** half-block of rock. Rebakes the flow field on placement, so the
  horde reroutes mid-run. It will refuse to seal the path completely.
- **BLADES** spinning disc, short range, cheap
- **BEAM** locks onto the thickest crowd and holds there, carving a hole
- **BOUNCE** zig-zag beam that reflects off rock, one damage segment per leg
- **MORTAR** shells the thickest crowd

Each weapon can only damage so many orcs per second, and `dps x hits/sec` is kept
in the same ballpark across all four, so the choice is about *shape* rather than
one weapon quietly doing all the work. That budget is also what makes a big enough
horde walk straight through your line.

**Click a turret to upgrade it.** Six levels, each 1.6x damage. Without upgrades
player power is flat while wave demand compounds about 30% a wave, which turns
every map into the same wall.

**Q / E** fire an airstrike and a nuke on cooldown, for density spikes.

## Controls

| | |
|---|---|
| `1` – `5` | rampart / blades / beam / bounce / mortar |
| `Q` / `E` | airstrike / nuke |
| click turret | upgrade it |
| left click | place |
| `SPACE` | call the next wave (rushes the breather) |
| wheel / right-drag | zoom / pan |
| `ESC` | pause menu |
| `M` | next map |
| `G` | sandbox toggle (base invulnerable) |
| `R` | restart |

## Run

```
node serve.mjs            # http://localhost:8099/
```

Needs WebGPU: Firefox 141+ on Windows, Chrome, or Edge. ES modules and import
maps mean it has to be served over http, `file://` will not work.

## Benchmark

The stress tools make the base invulnerable automatically, so a flood cannot end
the run. URL params:

| param | effect |
|---|---|
| `?orcs=N` | buffer capacity (default 250,000, or the saved setting) |
| `?spawn=N` | flood N orcs across the board at boot |
| `?bench=1` | no waves, keep ramping, base takes no damage |
| `?rate=N` | orcs added per ramp step (default 4000) |
| `?autobuild=1` | drop one of each turret along the path |
| `?ramparts=N` | paint N ramparts along the path |
| `?autoplay=1` | let the baseline bot play |
| `?speed=N` | N sim substeps per frame (1-16), for fast playtests |
| `?waves=N` | override the map's wave target |
| `?perf=1` | log a frame-time distribution every 60 frames |
| `?map=N` | load a map directly (no param = title screen) |

Measured on an RTX 5070 Ti, Chrome, 1600x900: **~95,000 orcs alive, live sim,
locked at 60 fps** (p50 16.7 ms, p95 16.8 ms) with compute 0.04–0.3 ms and render
0.1–0.6 ms per frame. The frame is vsync bound, not GPU bound.

The `compute` / `render` rows come from real WebGPU timestamp queries
(`renderer.trackTimestamp`), resolved off the frame path. They read `n/a` when the
device does not expose `timestamp-query`.

## Automated checks

```
node --test test/field.test.mjs                 # 8 tests: flow field logic, pure JS
node tools/smoke.mjs "http://localhost:8099/?bench=1&perf=1" 12
node tools/playtest.mjs                         # bot plays the maps, prints verdicts
```

`tools/smoke.mjs` drives a real browser over CDP, collects console output and
exceptions, prints a state heartbeat, and screenshots to `shots/`.

`tools/playtest.mjs` is how the campaign got balanced. It plays every map with the
baseline bot at 10 sim substeps per frame, so a 14-wave run resolves in about 20
seconds, and prints whether the map was held:

```
map 0: WIN  reached wave 12 of 12, 53,334 kills, hp 90
map 1: WIN  reached wave 14 of 14, 84,872 kills, hp 90
map 2: WIN  reached wave 13 of 13, 67,710 kills, hp 46
map 3: WIN  reached wave 12 of 12, 57,955 kills, hp 90

4/4 maps survivable by the baseline bot at their own wave targets.
```

The bot is deliberately unsophisticated: greedy spending, places on the busiest
legal spot using the density snapshot, never builds ramparts. If it can hold a
map, a person can. Every wave count and turret limit in the table above came out
of that loop, not out of a guess.

## Maps

`src/maps.js` holds 24x14 ASCII grids, upscaled 4x, so one authored character is
a 4-cell corridor (roughly 8 orcs abreast).

```
#  rock     .  dirt     S  orc portal     B  your base
```

Short rows pad with dirt and the border is always sealed. `node --test` will tell
you if a portal cannot reach the base, and `playtest.mjs` will tell you if the map
is fair.

## Layout

| file | |
|---|---|
| `src/field.js` | Dijkstra integration field, flow vectors, rock escape field, ray casting. Pure JS, node-testable |
| `src/gpu/horde.js` | storage buffers, the four compute passes, the instanced draw |
| `src/game/build.js` | placement rules, turret behaviour, damage-shape emission |
| `src/game/waves.js` | wave composition and spawn pacing |
| `src/ground.js` | map painted into a canvas, redrawn when rock changes |
| `src/art.js` | every texture, generated procedurally |
| `src/audio.js` | every sound, synthesised with WebAudio |
| `src/effects.js` | turret sprites, beam segments, blasts, build ghost |
| `src/menu.js` | title, map select, settings, pause, results |
| `src/save.js` | localStorage progress and settings |
| `src/hud.js` | DOM HUD and benchmark panel |

See `DESIGN.md` for why it is built this way, and `RESUME.md` to pick the work up
cold.
