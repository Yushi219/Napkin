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
  const f = (severity, where, issue, fix) => F.push({ severity, domain: 'structure', where, issue, fix });

  for (const m of masses) {
    const isMember = m.kind === 'member';
    const sup = m.on && m.on !== 'ground' ? byId.get(m.on) : null;

    // slenderness: a tall thin volume with nothing bracing it
    if (!isMember) {
      const slender = m.h / Math.max(0.1, Math.min(m.w, m.d));
      if (slender > 14) f('blocker', m.id, `slenderness ${slender.toFixed(0)}:1 — beyond what a plain structure stabilises`, 'thicken the plan, brace it, or lower it');
      else if (slender > 9) f('major', m.id, `slenderness ${slender.toFixed(0)}:1`, 'expect bracing or a core');
    }

    if (sup) {
      // bearing: how much of this volume actually stands on its support
      const ox = Math.max(0, Math.min(m.x + m.w / 2, sup.x + sup.w / 2) - Math.max(m.x - m.w / 2, sup.x - sup.w / 2));
      const oz = Math.max(0, Math.min(m.z + m.d / 2, sup.z + sup.d / 2) - Math.max(m.z - m.d / 2, sup.z - sup.d / 2));
      const share = (ox * oz) / Math.max(0.01, m.w * m.d);
      const reach = Math.max(
        (m.x + m.w / 2) - (sup.x + sup.w / 2), (sup.x - sup.w / 2) - (m.x - m.w / 2),
        (m.z + m.d / 2) - (sup.z + sup.d / 2), (sup.z - sup.d / 2) - (m.z - m.d / 2), 0);
      if (share < 0.18) f('blocker', m.id, `only ${(share * 100).toFixed(0)}% of its plan bears on ${sup.id}`, 'enlarge the overlap or add a column line');
      else if (share < 0.4 && !m.cantilever) f('major', m.id, `${(share * 100).toFixed(0)}% bearing on ${sup.id} without being declared a cantilever`, 'declare the cantilever or centre it');
      if (reach > 12) f('blocker', m.id, `cantilevers ${reach.toFixed(1)} m past ${sup.id} — transfer-structure territory`, 'pull it back or accept a visible truss');
      else if (reach > 6) f('major', m.id, `cantilevers ${reach.toFixed(1)} m past ${sup.id}`, 'expect a storey-deep beam or diagonal');
      // a member asked to carry a volume
      if (sup.kind === 'member' && !isMember) {
        const span = Math.max(sup.w, sup.d);
        f(span > 8 ? 'blocker' : 'major', m.id, `a ${Math.min(sup.w, sup.d).toFixed(1)} m member carries this volume`, 'thicken the support or add posts');
      }
    }

    // stacking weight: something heavier perched on something much smaller
    if (sup && !isMember && sup.kind !== 'member') {
      const areaRatio = (m.w * m.d) / Math.max(0.1, sup.w * sup.d);
      if (areaRatio > 2.2) f('major', m.id, `plan ${areaRatio.toFixed(1)}× its support ${sup.id}`, 'mushrooming this hard needs a transfer level');
    }
  }
  return F;
}

// ---------------- code (advisory, site-aware) ----------------

function codeChecks(masses, metrics, site) {
  const F = [];
  if (!masses?.length) return F;
  const f = (severity, where, issue, fix) => F.push({ severity, domain: 'code', where, issue, fix });
  const top = Math.max(...masses.map(m => m.y + m.h));

  // context height: graded against the measured neighbourhood when one exists
  if (site?.buildings?.length) {
    const hs = site.buildings.map(b => b.h).sort((a, b) => a - b);
    const tallest = hs[hs.length - 1];
    const median = hs[Math.floor(hs.length / 2)];
    if (top > tallest * 1.6) f('major', 'building', `${top.toFixed(0)} m against a tallest neighbour of ${tallest.toFixed(0)} m — expect contextual-height review`, 'step the upper storeys back or down');
    else if (top > median * 2.6) f('minor', 'building', `${top.toFixed(0)} m over a ${median.toFixed(0)} m median context`, 'check the district height map');
  } else if (top > 60) {
    f('minor', 'building', `${top.toFixed(0)} m with no site pinned — height unchecked against any district`, 'pin the project site to grade this properly');
  }

  // deep plans: daylight and egress heuristics
  for (const m of masses) {
    if (m.kind === 'member') continue;
    const minPlan = Math.min(m.w, m.d);
    if (minPlan > 36) f('major', m.id, `${minPlan.toFixed(0)} m deep plan — the middle is beyond daylight and likely beyond one egress run`, 'court, atrium, or split the volume');
    else if (minPlan > 24) f('minor', m.id, `${minPlan.toFixed(0)} m plan depth`, 'interior uses only at the core');
    const diag = Math.hypot(m.w, m.d) / 2;
    if (diag > 45) f('major', m.id, `~${diag.toFixed(0)} m from centre to exit — over common single-exit travel limits`, 'add a second stair');
  }

  // ground floor: does anything actually meet the ground
  const grounded = masses.some(m => m.y < 0.1 && m.kind !== 'member');
  if (!grounded) f('blocker', 'building', 'nothing occupiable meets the ground', 'someone has to be able to walk in');
  return F;
}

// ---------------- climate ----------------

function climateChecks(metrics) {
  const F = [];
  if (!metrics) return F;
  const f = (severity, where, issue, fix) => F.push({ severity, domain: 'climate', where, issue, fix });
  const carbon = +metrics.carbon || 0;
  const energy = +metrics.eui || 0;
  if (carbon > 800) f('major', 'building', `${carbon.toFixed(0)} kgCO₂e/m² embodied — well over common 2030 targets (~600)`, 'timber structure, less transfer, more repetition');
  else if (carbon > 620) f('minor', 'building', `${carbon.toFixed(0)} kgCO₂e/m² embodied`, 'the structure line in the dashboard is where it hides');
  if (energy > 160) f('major', 'building', `${energy.toFixed(0)} kWh/m²y — roughly double a good envelope`, 'compactness and glazing ratio first');
  else if (energy > 110) f('minor', 'building', `${energy.toFixed(0)} kWh/m²y operational`, 'consider the surface-to-volume ratio');
  return F;
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
  return { findings, counts, worstByElement, clean: findings.length === 0 };
}
