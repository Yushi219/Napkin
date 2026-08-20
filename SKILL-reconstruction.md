# The reconstruction protocol

How NAPKIN turns one drawing into a verified parametric model. The point is
not speed — it is that every stage produces something checkable, and nothing
ships until two independent audits pass.

## Stages

| # | Stage | Who | Artifact |
|---|-------|-----|----------|
| 0 | Crop | code | reference trimmed to its ink (`cropReferenceImage`) |
| 1 | Forensics | Claude, forced tool | locked survey: levels, features **with evidence**, hypotheses **with confidence and falsifier**, envelope, camera |
| 2 | Layered build | Claude, tool loop | `submit_level` per storey group, lowest first; each stage gets its **silhouette measured off an actual render** before the next |
| 3 | Geometry audit | code, deterministic | `geometryAudit`: floaters, cyclic supports, off-seat, interpenetration, member plausibility |
| 4 | Visual review | a second, independent Claude call | reference vs render, graded findings |
| 5 | Convergence | loop | `replace_scene` → re-audit → re-review, until clean or budget ends |

`finish` is refused while either audit still holds a blocker or a major.

## The audit grammar

Every finding, from code or reviewer, speaks one syntax:

```json
{ "severity": "blocker | major | minor",
  "where":    "<element id or pair>",
  "issue":    "<what is wrong>",
  "fix":      "<the shortest way to make it right>" }
```

- **blocker** — structurally wrong; building on it compounds the error
  (cyclic support, floater, missing parent, empty scene)
- **major** — clearly visible deviation (off its seat > 3 cm, unrelated
  interpenetration > 8 %, wrong level count, missing opening)
- **minor** — cosmetic; may survive convergence (slight overlap, suspected
  intersection between rotated pairs)

Geometry findings come from code and are non-negotiable. Visual findings are
argued against the drawing and the survey only — never against taste.

## Hypotheses

Where the drawing is ambiguous the survey must say so, as
`{ claim, confidence, falsifiedBy }`. The builder honours hypotheses until a
render disproves them; a falsified hypothesis is corrected, not defended.

## The cage

The model lives as a **low-poly quad control cage** throughout: few,
deliberate solids (`kind: volume | slab | member`), every elevated element
naming its true support, touching faces sharing exact coordinates. The Rhino
export ships `napkin-cage.obj` — welded quad boxes, one object per element —
so in Rhino it is *select → ToSubD* and the massing can be pushed around like
clay without losing the audited composition.

## Engines

Claude (default `claude-opus-5`) runs the protocol; the ChatGPT builder loop
remains as the fallback engine when only an OpenAI key is present. Keys live
in the browser's localStorage and are sent only to their own APIs.
