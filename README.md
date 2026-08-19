# NAPKIN — six months to thirty seconds

Every great building starts on a napkin. Then it takes six months to learn
whether it stands, what it costs, and whether it is legal. NAPKIN compresses
the six months into thirty seconds — and keeps the napkin.

## Run it

Any static server, no build step. From the parent folder:

```bash
python -m http.server 8137
```

then open `http://localhost:8137/Napkin/`. All 3D runs on vendored three.js —
fully offline except the optional AI calls.

## The three jumps (forward)

1. **Sketch** — draw on the napkin with a pencil-textured brush (pressure from
   speed, graphite grain), or upload a photo of a real napkin. Two readings:
   *Silhouette* (front elevation → floors, setbacks, taper via row-scan) and
   *Plan* (closed outline → footprint polygon via contour trace). Drawn strokes
   are vectors — no ML needed; photos go through adaptive thresholding into the
   exact same pipeline. Claude vision (optional) advises on photos.
2. **Build** — the parametric model rises in the middle pane. In plan mode the
   left pane splits: sketch above, ink line-study below. Keep drawing — the
   model follows your hand live.
3. **Render** — Nano Banana Pro (Gemini) re-renders the massing with a style
   preset, your art direction, and an optional style-reference image. No key?
   A local stylization answers instead — the demo never blocks.

## The two jumps back (reverse)

- **⇪ Decompose** (right pane): upload a rendering or photo of a building —
  Claude vision decomposes it into massing parameters (floors, taper, twist,
  setbacks, program); silhouette extraction is the no-key fallback. No napkin
  involved.
- **⇪ 3D** (middle pane): upload an .obj/.glb — it takes the stage for
  rendering, and its **orthographic silhouette is fed back through the same
  interpreter the napkin uses** to derive an editable parametric twin. Reverse
  and forward share one brain.

## Talk to it

The chat bar edits the 3D model in natural language — English or Chinese:
"three floors taller", "twist it 25 degrees", "改成实验室，加个绿屋顶".
Claude translates speech to clamped parameter edits; a bilingual keyword
engine answers offline. Every edit is a version commit.

## Dashboard

Nine live metrics, each **clickable with its methodology and source**: height
and FAR against Boston Zoning Article 13, embodied carbon (CLF benchmarks),
cost (program-adjusted), structural pre-check (slenderness proxy — the VIKTOR
role), daylight, EUI (CBECS baselines), and a documented LEED v4 estimate with
certification tier. The program dropdown (office / laboratory / residential /
hotel / school / custom) re-bases everything — a lab is not an office with
benches.

## Scene design

The model viewport includes program-specific landscape proposals rather than a
single generic context. Open **Landscape** to choose among detailed settings
with different circulation, planting, water, urban fabric, furniture, lighting
and scale figures. Open the adjacent sky control to choose one of eight locally
bundled, photographic 360° panoramas. The visible clouds are real CC0 sky
photographs; sun geometry, shadows, wet-ground response, rain and snow remain
live model effects. Source credits are documented in `assets/skies/README.md`.

## Rhino handoff

**⇩ Rhino** writes a real `.3dm` in the browser (rhino3dm WASM) — meshes on a
named layer, metres, with the full parameter state embedded as document user
text (`napkin.params`). Drag into Rhino 6/7/8 and keep working. If WASM fails,
an .obj downloads instead.

### Rebuilding it in Grasshopper (the parametric path)

The exported `napkin.params` is deliberately shaped like a GH slider rig:

```
floors, floorHeight, baseWidth, baseDepth, twist, taper, orientation,
segments[{fromFloor, scale}], footprint[[x,y]…], greenRoof, structure, type
```

Recipe: one number slider per scalar; footprint → interpolated polyline;
per-floor logic = `Series(floors)` → scale by `segments`/taper → rotate by
`twist × t` → extrude `floorHeight`. That is the whole replay engine in ~15
components. Host that definition on **ShapeDiver** and point the adapter at it
(⚙ settings) — the app's local rebuild and the cloud rebuild are the same
semantics by construction. This mirrors `CONCORD/rhino/gh_schema_export.py`,
which goes the other way (any GH definition → op schema).

## Sponsor seats (v1 = local twins, honest labels)

- **ShapeDiver** — cloud parametric reconstruction. Local replay engine today;
  the params JSON is the ticket payload tomorrow.
- **VIKTOR** — structural pre-check. Local slenderness/drift proxy today; the
  metric card is the embed slot.
- **Speckle** — the version stream (v-button) with sketch thumbnails, full
  state and metric briefs per commit; export is Speckle-commit-shaped JSON.

## Keys (⚙)

- Anthropic — chat modelling, photo advice, render decomposition
- Gemini — Nano Banana Pro renders
Everything degrades gracefully without them. Keys stay in localStorage and go
only to their own APIs.
