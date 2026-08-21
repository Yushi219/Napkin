// The auditor. A drawing becomes a model; this is where the model becomes an
// argument. Three domains of checks, every finding in the shared grammar
// { severity, domain, where, issue, fix }, every one recomputed the moment a
// parameter moves:
//
//   STRUCTURE — cantilever reach, slenderness, bearing area, load path,
//               members asked to carry volumes
//   CODE      — advisory checks graded against the pinned site's own context
//               (height vs the measured neighbourhood, plan depth, egress
//               reach), honestly labelled heuristics, not legal text
//   CLIMATE   — carbon and energy against type benchmarks
//
// Severity is the same scale the build protocol uses: blocker (red) — the
// scheme has a structural or legal problem to resolve; major (orange) — needs
// attention before this goes further; minor (yellow) — worth knowing.

export const AUDIT_COLORS = { blocker: 0xd4453a, major: 0xe08a3c, minor: 0xd9b545 };

// ---------------- structure ----------------

function structureChecks(masses) {
  const F = [];
  if (!masses?.length) return F;
  const byId = new Map(masses.map(m => [m.id, m]));
  const f = (severity, where, issue, fix, why) => F.push({ severity, domain: 'structure', where, issue, fix, why });

  for (const m of masses) {
    const isMember = m.kind === 'member';
    const sup = m.on && m.on !== 'ground' ? byId.get(m.on) : null;

    // slenderness: a tall thin volume with nothing bracing it
    if (!isMember) {
      const slender = m.h / Math.max(0.1, Math.min(m.w, m.d));
      if (slender > 14) f('blocker', m.id, `slenderness ${slender.toFixed(0)}:1 — beyond what a plain structure stabilises`, 'thicken the plan, brace it, or lower it', `Height ${m.h.toFixed(1)} m against a least plan dimension of ${Math.min(m.w, m.d).toFixed(1)} m. Unbraced masonry and frame construction is normally kept under about 10:1; past ~14:1 a plain floor-plate structure cannot resist wind sway without a core or outriggers.`);
      else if (slender > 9) f('major', m.id, `slenderness ${slender.toFixed(0)}:1`, 'expect bracing or a core', `Height ${m.h.toFixed(1)} m over a ${Math.min(m.w, m.d).toFixed(1)} m least dimension. Buildable, but it stops being a stack of floor plates \u2014 it needs a shear core, braced bay or outrigger to hold the top still.`);
    }

    if (sup) {
      // bearing: how much of this volume actually stands on its support
      const ox = Math.max(0, Math.min(m.x + m.w / 2, sup.x + sup.w / 2) - Math.max(m.x - m.w / 2, sup.x - sup.w / 2));
      const oz = Math.max(0, Math.min(m.z + m.d / 2, sup.z + sup.d / 2) - Math.max(m.z - m.d / 2, sup.z - sup.d / 2));
      const share = (ox * oz) / Math.max(0.01, m.w * m.d);
      const reach = Math.max(
        (m.x + m.w / 2) - (sup.x + sup.w / 2), (sup.x - sup.w / 2) - (m.x - m.w / 2),
        (m.z + m.d / 2) - (sup.z + sup.d / 2), (sup.z - sup.d / 2) - (m.z - m.d / 2), 0);
      if (share < 0.18) f('blocker', m.id, `only ${(share * 100).toFixed(0)}% of its plan bears on ${sup.id}`, 'enlarge the overlap or add a column line', `Plan overlap with ${sup.id} is ${(ox * oz).toFixed(1)} m\u00b2 of this volume's ${(m.w * m.d).toFixed(1)} m\u00b2 footprint. Below roughly a fifth, the load has no path down: what is left is a cantilever pretending to be a bearing wall.`);
      else if (share < 0.4 && !m.cantilever) f('major', m.id, `${(share * 100).toFixed(0)}% bearing on ${sup.id} without being declared a cantilever`, 'declare the cantilever or centre it', `${(ox * oz).toFixed(1)} m\u00b2 of ${(m.w * m.d).toFixed(1)} m\u00b2 bears on ${sup.id}. Under about 40% the overhang governs the design of every floor beam, so it should be modelled and costed as a cantilever rather than as a wall on a wall.`);
      if (reach > 12) f('blocker', m.id, `cantilevers ${reach.toFixed(1)} m past ${sup.id} — transfer-structure territory`, 'pull it back or accept a visible truss', `${reach.toFixed(1)} m clear of ${sup.id}. Concrete and steel floor cantilevers are ordinarily kept near a third of the backspan; past about 12 m the moment needs a storey-deep transfer truss or post-tensioning, which is a structural decision, not a detail.`);
      else if (reach > 6) f('major', m.id, `cantilevers ${reach.toFixed(1)} m past ${sup.id}`, 'expect a storey-deep beam or diagonal', `${reach.toFixed(1)} m past ${sup.id}. A cantilever of this reach needs a beam roughly a tenth to a twelfth of its span in depth \u2014 around ${(reach / 11).toFixed(1)} m \u2014 so it will read on the elevation.`);
      // a member asked to carry a volume
      if (sup.kind === 'member' && !isMember) {
        const span = Math.max(sup.w, sup.d);
        f(span > 8 ? 'blocker' : 'major', m.id, `a ${Math.min(sup.w, sup.d).toFixed(1)} m member carries this volume`, 'thicken the support or add posts', `${sup.id} is ${Math.min(sup.w, sup.d).toFixed(2)} m in its least dimension and is carrying a volume of ${(m.w * m.d * m.h).toFixed(0)} m\u00b3. Members are sized for their own weight and a rail load, not a floor above.`);
      }
    }

    // stacking weight: something heavier perched on something much smaller
    if (sup && !isMember && sup.kind !== 'member') {
      const areaRatio = (m.w * m.d) / Math.max(0.1, sup.w * sup.d);
      if (areaRatio > 2.2) f('major', m.id, `plan ${areaRatio.toFixed(1)}× its support ${sup.id}`, 'mushrooming this hard needs a transfer level', `${(m.w * m.d).toFixed(0)} m\u00b2 sitting on ${(sup.w * sup.d).toFixed(0)} m\u00b2. Every column above has to find one below; past roughly twice the area that means a transfer slab or truss, which is expensive and thick.`);
    }
  }
  return F;
}

// ---------------- code (advisory, site-aware) ----------------

function codeChecks(masses, metrics, site) {
  const F = [];
  if (!masses?.length) return F;
  const f = (severity, where, issue, fix, why) => F.push({ severity, domain: 'code', where, issue, fix, why });
  const top = Math.max(...masses.map(m => m.y + m.h));

  // context height: graded against the measured neighbourhood when one exists
  if (site?.buildings?.length) {
    const hs = site.buildings.map(b => b.h).sort((a, b) => a - b);
    const tallest = hs[hs.length - 1];
    const median = hs[Math.floor(hs.length / 2)];
    if (top > tallest * 1.6) f('major', 'building', `${top.toFixed(0)} m against a tallest neighbour of ${tallest.toFixed(0)} m — expect contextual-height review`, 'step the upper storeys back or down', `Measured from the ${site.buildings.length} buildings OpenStreetMap holds around this parcel: tallest ${tallest.toFixed(0)} m, median ${median.toFixed(0)} m. Contextual-height provisions in most cities test against exactly this comparison.`);
    else if (top > median * 2.6) f('minor', 'building', `${top.toFixed(0)} m over a ${median.toFixed(0)} m median context`, 'check the district height map', `The measured median around this parcel is ${median.toFixed(0)} m across ${site.buildings.length} buildings. Not a violation \u2014 a flag that the district plan is worth reading before this height is fixed.`);
  } else if (top > 60) {
    f('minor', 'building', `${top.toFixed(0)} m with no site pinned — height unchecked against any district`, 'pin the project site to grade this properly', 'Height limits are always local. Without a pinned site there is no measured neighbourhood to compare against, so this is only a note that the question is unanswered.');
  }

  // deep plans: daylight and egress heuristics
  for (const m of masses) {
    if (m.kind === 'member') continue;
    const minPlan = Math.min(m.w, m.d);
    if (minPlan > 36) f('major', m.id, `${minPlan.toFixed(0)} m deep plan — the middle is beyond daylight and likely beyond one egress run`, 'court, atrium, or split the volume', `Least plan dimension ${minPlan.toFixed(0)} m, so the deepest interior point is about ${(minPlan / 2).toFixed(0)} m from a facade. Useful daylight reaches roughly twice the head height \u2014 about 7 m \u2014 and common single-direction travel limits are shorter than this.`);
    else if (minPlan > 24) f('minor', m.id, `${minPlan.toFixed(0)} m plan depth`, 'interior uses only at the core', `${minPlan.toFixed(0)} m deep, so about ${(minPlan / 2).toFixed(0)} m from facade to centre. Beyond roughly 12 m the middle is permanently artificially lit \u2014 fine for plant, stores and circulation, poor for occupied rooms.`);
    const diag = Math.hypot(m.w, m.d) / 2;
    if (diag > 45) f('major', m.id, `~${diag.toFixed(0)} m from centre to exit — over common single-exit travel limits`, 'add a second stair', `Half-diagonal is ${diag.toFixed(0)} m, the worst case walk to a single exit. Codes commonly cap single-exit travel between 20 and 45 m depending on use and sprinklers, so this plan almost certainly needs a second stair.`);
  }

  // ground floor: does anything actually meet the ground
  const grounded = masses.some(m => m.y < 0.1 && m.kind !== 'member');
  if (!grounded) f('blocker', 'building', 'nothing occupiable meets the ground', 'someone has to be able to walk in', 'No occupiable volume has its base within 0.1 m of ground level. Either the entrance storey is missing from the model, or the whole building floats.');
  return F;
}

// ---------------- climate ----------------

function climateChecks(metrics) {
  const F = [];
  if (!metrics) return F;
  const f = (severity, where, issue, fix, why) => F.push({ severity, domain: 'climate', where, issue, fix, why });
  const carbon = +metrics.carbon || 0;
  const energy = +metrics.eui || 0;
  if (carbon > 800) f('major', 'building', `${carbon.toFixed(0)} kgCO₂e/m² embodied — well over common 2030 targets (~600)`, 'timber structure, less transfer, more repetition', `${carbon.toFixed(0)} kgCO\u2082e/m\u00b2 upfront. LETI and RIBA 2030 targets sit near 300\u2013600 for most types; transfer structure, deep cantilevers and one-off geometry are where the excess usually is.`);
  else if (carbon > 620) f('minor', 'building', `${carbon.toFixed(0)} kgCO₂e/m² embodied`, 'the structure line in the dashboard is where it hides', `${carbon.toFixed(0)} kgCO\u2082e/m\u00b2 upfront, against a common 2030 benchmark around 600. Structure is typically half of it.`);
  if (energy > 160) f('major', 'building', `${energy.toFixed(0)} kWh/m²y — roughly double a good envelope`, 'compactness and glazing ratio first', `${energy.toFixed(0)} kWh/m\u00b2\u00b7y modelled. A well-insulated envelope of this type lands nearer 70\u201390; surface-to-volume ratio and glazing fraction dominate before any plant is chosen.`);
  else if (energy > 110) f('minor', 'building', `${energy.toFixed(0)} kWh/m²y operational`, 'consider the surface-to-volume ratio', `${energy.toFixed(0)} kWh/m\u00b2\u00b7y modelled, moderately above a good envelope for this type.`);
  return F;
}


// ---------------- the review table ----------------
// The same findings, seated. Each discipline reviews what it is responsible
// for and speaks in its own voice, so a scheme is not judged by one anonymous
// list but by the people who would actually be in the room.

export const REVIEWERS = [
  { id: 'structure', name: 'Priya', role: 'Structural engineer',
    domains: ['structure'], accent: '#c1553f',
    quiet: 'It stands up. Nothing here needs a transfer or a truss.' },
  { id: 'planner', name: 'Marcus', role: 'Planning officer',
    domains: ['code'], accent: '#4a6fa5',
    quiet: 'Nothing that would stop a planning submission on massing grounds.' },
  { id: 'sustainability', name: 'Lena', role: 'Sustainability lead',
    domains: ['climate'], accent: '#4a9d5b',
    quiet: 'Carbon and energy both sit inside the benchmarks for this type.' },
];

// Portraits, drawn rather than fetched: flat, quiet, one silhouette each, told
// apart by hard hat, collar and headscarf rather than by caricature.
export const FACES = {
  structure: `<svg viewBox="0 0 48 48" aria-hidden="true">
    <circle cx="24" cy="24" r="23" class="rt-bg"/>
    <path d="M12 40v-3c0-5 5.4-8 12-8s12 3 12 8v3z" class="rt-body"/>
    <circle cx="24" cy="19" r="8" class="rt-skin"/>
    <path d="M10.5 15.5h27a13.5 13.5 0 0 0-27 0z" class="rt-hat"/>
    <path d="M8 15.5h32" class="rt-line"/>
    <path d="M24 2.5v5" class="rt-line"/></svg>`,
  planner: `<svg viewBox="0 0 48 48" aria-hidden="true">
    <circle cx="24" cy="24" r="23" class="rt-bg"/>
    <path d="M12 40v-3c0-5 5.4-8 12-8s12 3 12 8v3z" class="rt-body"/>
    <path d="M19 29.5 24 36l5-6.5" class="rt-collar"/>
    <circle cx="24" cy="18" r="8" class="rt-skin"/>
    <path d="M15.5 16c1-6 6-8.5 8.5-8.5S32 10 32.5 16c-2.5-1.5-4-4-4-4s-4 3.5-13 4z" class="rt-hair"/></svg>`,
  sustainability: `<svg viewBox="0 0 48 48" aria-hidden="true">
    <circle cx="24" cy="24" r="23" class="rt-bg"/>
    <path d="M12 40v-3c0-5 5.4-8 12-8s12 3 12 8v3z" class="rt-body"/>
    <circle cx="24" cy="19" r="7.5" class="rt-skin"/>
    <path d="M24 8.5c6 0 9.5 4.4 9.5 10 0 3-1 5-1 5l-2-6.5s-4 2-8.5 2-6.5-1.5-6.5-1.5l-1 6s-1-2.4-1-5c0-5.6 4.5-10 10.5-10z" class="rt-scarf"/>
    <path d="M34 15c2.5 2 3.5 5.5 2.5 8.5" class="rt-leaf"/></svg>`,
};

// What to actually change, in the language of the sliders on screen. Only
// advice that names a parameter and a direction earns a place — "improve
// daylight" helps nobody.
export function optimisationAdvice(findings, masses, metrics) {
  if (!masses?.length) return [];
  const out = [];
  const seen = new Set();
  const add = (a) => { const k = a.what + a.target; if (!seen.has(k)) { seen.add(k); out.push(a); } };
  const byId = new Map(masses.map(m => [m.id, m]));

  for (const x of findings) {
    const m = byId.get(x.where);
    if (/slenderness/.test(x.issue) && m) {
      const need = +(m.h / 9).toFixed(1);
      const grow = +(need - Math.min(m.w, m.d)).toFixed(1);
      if (grow > 0.1) add({ target: x.where, what: (m.w <= m.d ? 'w' : 'd'),
        text: `Widen ${x.where}'s ${m.w <= m.d ? 'width' : 'depth'} by ${grow} m (to ${need} m) — that brings slenderness to 9:1, the point where a plain frame stops needing a core.`,
        severity: x.severity });
    }
    if (/bears on|cantilevers/.test(x.issue) && m) {
      const sup = byId.get(m.on);
      if (sup) {
        const toward = +( (sup.x - m.x) ).toFixed(1);
        if (Math.abs(toward) > 0.3) add({ target: x.where, what: 'x',
          text: `Slide ${x.where} ${Math.abs(toward) > 0 ? (toward > 0 ? 'right' : 'left') : ''} by ${Math.abs(toward).toFixed(1)} m to sit over ${sup.id} — or declare the cantilever and carry a storey-deep beam.`,
          severity: x.severity });
      }
    }
    if (/plan depth|deep plan/.test(x.issue) && m) {
      const cut = +(Math.min(m.w, m.d) - 24).toFixed(1);
      if (cut > 0.5) add({ target: x.where, what: (m.w <= m.d ? 'w' : 'd'),
        text: `Take ${cut} m off ${x.where}'s ${m.w <= m.d ? 'width' : 'depth'}, or cut a court through it — the middle is past useful daylight.`,
        severity: x.severity });
    }
    if (/kgCO/.test(x.issue)) add({ target: 'building', what: 'structure',
      text: `Switch the structure to timber-hybrid in Params — typically 25-40% off upfront carbon before any geometry changes.`,
      severity: x.severity });
    if (/kWh/.test(x.issue)) {
      const glassy = masses.filter(v => v.facade === 'glass').length;
      add({ target: 'building', what: 'facade',
        text: glassy
          ? `${glassy} volume${glassy > 1 ? 's are' : ' is'} fully glazed — moving one or two to slats-v or solid is the cheapest move on the energy line.`
          : `Compactness governs here: fewer, deeper volumes lower the surface-to-volume ratio more than any envelope spec.`,
        severity: x.severity });
    }
  }
  const rank = { blocker: 0, major: 1, minor: 2 };
  out.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return out.slice(0, 6);
}

// ---------------- the audit ----------------

export function runAudit({ masses, metrics, site }) {
  const findings = [
    ...structureChecks(masses),
    ...codeChecks(masses, metrics, site),
    ...climateChecks(metrics),
  ];
  const rank = { blocker: 0, major: 1, minor: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
  const counts = { blocker: 0, major: 0, minor: 0 };
  for (const x of findings) counts[x.severity]++;
  // per-element worst severity, for the shells
  const worstByElement = {};
  for (const x of findings) {
    if (x.where === 'building') continue;
    if (!(x.where in worstByElement) || rank[x.severity] < rank[worstByElement[x.where]]) worstByElement[x.where] = x.severity;
  }
  // seat the findings at the table
  const table = REVIEWERS.map(r => ({
    ...r,
    findings: findings.filter(x => r.domains.includes(x.domain)),
  }));
  return { findings, counts, worstByElement, table,
    advice: optimisationAdvice(findings, masses, metrics),
    clean: findings.length === 0 };
}
