# ORCFLOW

### *sir, we have a flow field*

GPU tower defense in Three.js. Every orc lives in a WebGPU storage buffer for its
whole life: navigation, crowd separation, damage, death and recycling all happen
in compute shaders. The CPU sets uniforms, bakes flow fields, and draws.

**Play it: [tront.xyz/orcflow](https://tront.xyz/orcflow/)** (needs WebGPU)

## Credits, and what this is

Inspired by **[Sir, We Have an Orc Problem](https://store.steampowered.com/search/?term=Sir%2C+We+Have+an+Orc+Problem)**
by **Mumpitz Games** (Laurin + Stephan). Go buy theirs, they did the hard part.

This is a clean-room tech homage built in a day, not a clone for sale. No code, art
or assets of theirs are used: every texture here is drawn procedurally on a canvas at
boot, the maps are mine, the whole thing is MIT and earns nothing. Not affiliated
with or endorsed by Mumpitz Games.

It exists to answer one question. Is the tech behind a 100k-enemy horde game a moat
in 2026? No. Finishing a game still is, and that part is entirely theirs.

## Run

```
node serve.mjs            # http://localhost:8099/
```

Needs WebGPU: Firefox 141+ on Windows, Chrome, or Edge. ES modules and import
maps mean it has to be served over http, `file://` will not work.

## Controls

| | |
|---|---|
| `1` – `5` | rampart / blades / beam / bounce / mortar |
| left click | place |
| `SPACE` | call the next wave (rushes the breather) |
| wheel / right-drag | zoom / pan |
| `M` | next map |
| `G` | sandbox toggle (base invulnerable) |
| `P` / `R` | pause / restart |

Ramparts are the interesting part: painting one rebakes the flow field, so the
horde reroutes mid-run and you can steer the river.

## Benchmark

The stress tools make the base invulnerable automatically, so a flood cannot end
the run. URL params:

| param | effect |
|---|---|
| `?orcs=N` | buffer capacity (default 250,000) |
| `?spawn=N` | flood N orcs across the board at boot |
| `?bench=1` | no waves, keep ramping, base takes no damage |
| `?rate=N` | orcs added per ramp step (default 4000) |
| `?autobuild=1` | drop one of each turret along the path |
| `?perf=1` | log a frame-time distribution every 60 frames |
| `?map=N` | pick a map (0-3) |

Measured on an RTX 5070 Ti, Chrome, 1600x900: **~95,000 orcs alive, live sim,
locked at 60 fps** (p50 16.7 ms, p95 16.8 ms) with compute 0.04–0.3 ms and render
0.1–0.6 ms per frame. The frame is vsync bound, not GPU bound: the horde is not
what costs you anything.

The `compute` / `render` rows come from real WebGPU timestamp queries
(`renderer.trackTimestamp`), resolved off the frame path. They read `n/a` when the
device does not expose `timestamp-query`.

## Automated checks

```
node --test test/field.test.mjs        # flow field: connectivity, escape vectors, byte range
node tools/smoke.mjs "http://localhost:8099/?bench=1&perf=1" 12
```

`tools/smoke.mjs` drives a real browser over CDP, collects console output and
exceptions, prints a state heartbeat, and screenshots to `shots/`. It opens its
own tab and closes only that tab.

## Maps

`src/maps.js` holds 24x14 ASCII grids, upscaled 4x, so one authored character is
a 4-cell corridor (roughly 8 orcs abreast).

```
#  rock     .  dirt     S  orc portal     B  your base
```

Short rows pad with dirt and the border is always sealed, so you can sketch a map
without counting edges. `node --test` will tell you if a portal cannot reach the
base.

## Layout

| file | |
|---|---|
| `src/field.js` | Dijkstra integration field, flow vectors, rock escape field, ray casting. Pure JS, node-testable |
| `src/gpu/horde.js` | storage buffers, the four compute passes, the instanced draw |
| `src/game/build.js` | placement rules, turret behaviour, damage-shape emission |
| `src/game/waves.js` | wave composition and spawn pacing |
| `src/ground.js` | map painted into a canvas, redrawn when rock changes |
| `src/art.js` | every texture, generated procedurally |
| `src/effects.js` | turret sprites, beam segments, blasts, build ghost |
| `src/hud.js` | DOM HUD and benchmark panel |

See `DESIGN.md` for why it is built this way.
