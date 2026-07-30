# ORCFLOW design notes

The goal: 100k orcs on screen, colliding, taking damage from area weapons, at
60 fps in a browser. That number is the design constraint everything else bends
around.

## Frame shape

```
[ CPU ]  wave clock, turret aims, rampart edits -> Dijkstra bake -> flow texture
              |  uniforms only. The CPU never holds an orc.
[ spawn   ]   up to 2048 threads, writes new orcs at a ring cursor
[ scatter ]   every live orc atomically bumps a coarse density cell
[ sim     ]   steer down the flow field, push out of crowds, take damage, die
[ clear   ]   zero the density grid for next frame
[ render  ]   one instanced draw, positions read straight from the storage buffer
[ readback]   async staging copies, never awaited in the frame path
```

Dispatches are bounded by a high-water mark of slots ever used, so early waves
cost a few thousand threads rather than the full capacity, and the same window
bounds `geometry.instanceCount`.

## Decisions

**Flow field, not pathfinding.** 100k A\* agents is absurd; one Dijkstra
integration field from the base is ~2 ms for 5,376 cells and every orc becomes a
texture read. Packed RGBA8 (direction in RG, rock flag in B, distance in A)
because 8 bits of direction is plenty and rgba8unorm is filterable everywhere.
Compute shaders cannot use filtered sampling, so the shader blends four
`textureLoad`s by hand; rock collision uses a single unfiltered load so it stays
exact.

**Rock cells carry an escape vector.** A "point at your cheapest open neighbour"
rule leaves the interior of a slab with a zero vector, and anything standing
there is stuck forever. That is not a corner case: it happens the moment a player
drops a rampart on a crowd. So a breadth-first pass walks outward from the rock
that touches open ground, each cell pointing at its parent. The sim also skips
its own collision rejection while an orc is inside rock, otherwise the escape
route is blocked by the very check meant to keep orcs out.

**Physics first, steering never louder than the field.** The crowd is a contact
simulation: discs that resolve overlap against a spatial hash and cancel the
closing part of their relative velocity, twice a frame. The flow field is the only
thing that *steers*. An earlier version layered six steering terms on top
(cohesion, velocity alignment, a pressure gradient, curl noise, jam slowdown, wall
drag) and they spent their time fighting each other and the field: crowds twitched
in place, and a dense clump could reach an equilibrium where every term cancelled
and the blob simply parked.

The rule going forward, if steering behaviours come back: **build the physics
first, then let every behaviour submit a recommendation, weight them into a single
force, and cap that force so it can never outweigh the flow field.** Six
independent forces mutating velocity in sequence is not a system, it is six
authors arguing inside one loop.

**Density grid, doubling as a spatial hash.** Orcs atomically write into a half-unit grid
and steer down its gradient. A real GPU hash needs count / prefix-sum / scatter
passes; this needs two, and it produces the nose-to-tail river look the reference
game has. The scatter-then-read-then-clear order means every read sees a complete
frame with no double buffering.

**Weapons are flat shapes, evaluated orc-side.** Two primitives only: a disc, and
a segment with a half-width. Damage is applied inside the sim pass, so there is
no target-selection pass and no per-turret orc list. Single-target turrets would
need a reduction; area weapons are also what a horde game wants.

- **blades** one disc
- **beam** one segment, locked onto the thickest crowd for a dwell so it visibly
  carves. A slowly sweeping beam touches too few orcs for too short a time and
  reads as broken.
- **bounce** one segment per reflection leg. The shader has no idea reflection
  exists: the CPU marches a ray, flips the component of the crossed face, and
  emits legs.
- **mortar** blasts, which are discs with a short life

**Ring-buffer recycling, no free list.** Dying orcs stay in place as corpses that
fade, and the spawn cursor overwrites the oldest slots. Cost is O(spawned), not
O(capacity), and no compaction pass is needed. Past capacity the headcount
plateaus instead of climbing, which the HUD flags as recycling.

**Corpses instead of a decal buffer.** A dead orc keeps its slot, switches to the
gore atlas tile, and darkens as it "dries" before the slot is reusable. That is
the whole blood system: no render target, no extra pass, and the gore fields
accumulate exactly where the fighting was.

**Cutout, not alpha blending.** `alphaTest` with nearest filtering keeps the pixel
art crisp and, more importantly, keeps depth sorting honest, so corpses layer
under the living without sorting 100k transparent quads.

**Plain Mesh with an InstancedBufferGeometry**, not an `InstancedMesh`: three
multiplies `positionLocal` by the instance matrix, and the default matrices are
zeroed, which collapses everything to the origin.

## GPU to CPU

Nothing is read back synchronously. Kills, leaks and gold are monotonic atomic
counters; the CPU diffs an async snapshot (`getArrayBufferAsync` is a staging
copy plus `mapAsync` underneath) with one request in flight at most. Monotonic
means no clear pass and no lost counts if a frame's readback is skipped.

The same mechanism does something less obvious: the density grid is snapshotted
asynchronously every ~10 frames (83 KB), which gives beams and mortars a coarse
crowd map to aim at. The CPU picks the thickest cell without ever knowing that an
individual orc exists.

Everything purely visual stays GPU-side, so there is no event round trip for
corpses, blood or hit flashes.

## Where the bodies are buried

Bugs this shook out, kept here because they are all easy to reintroduce:

- **Float32 cost array.** Dijkstra's `sqrt(2)` steps are doubles; rounding them
  into a Float32 store made the stale-entry check reject valid pops and silently
  truncated the flood fill to about a third of the map. Float64.
- **Both-sided wall rows.** The first SNAKE map opened every wall row on both
  ends, which turned the serpentine into a straight run down the left edge.
- **Chrome occlusion.** Cover the window and Chrome stops rAF entirely: zero
  frames, no error, a frozen HUD that looks exactly like a GPU hang. The smoke
  tool now passes `--disable-features=CalculateNativeWinOcclusion` and friends.
- **Flood ends the run.** Board floods spawn orcs on the base, which drains 90 HP
  in one frame. Stress tools now enter sandbox mode.

## Not built yet

Tracer rounds as real GPU particles; a GPU event ring buffer for audio and
floating damage text; turret upgrades and selling; multiple portals per map;
biome palettes beyond the dirt one; indirect dispatch for blood particles.
