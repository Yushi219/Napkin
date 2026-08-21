// The auditor. A drawing becomes a model; this is where the model becomes an
// argument. Rebuilt on the constructability research (sources in
// SKILL-reconstruction.md): every threshold is cited or explicitly labelled a
// heuristic, structural proportion rules never run on detail-tier texture,
// findings are grouped by root cause and ranked by consequence — cost of the
// fix × how much of the building rides on the error × how sure the check is.
//
// Two kinds of claim, never merged: FACTS (rigid-body geometry — floats,
// unreachable ground, resultant off the support; confidence 1.0) and
// HEURISTICS (span-to-depth, daylight depth; the real structure is unknown at
// massing, so these are proportion advice, confidence ~0.5, and say so).

export const AUDIT_COLORS = { blocker: 0xd4453a, major: 0xe08a3c, minor: 0xd9b545, note: 0x8a93a5 };

const CONTACT_GAP = 0.12;      // m — a seam this fine is a joint, not a gap

const tierOf = m => m.tier || (m.kind === 'member' ? 'detail'
  : (m.kind === 'slab' || ['canopy', 'roof', 'balcony', 'frame', 'screen'].includes(m.role) ? 'secondary' : 'primary'));

function footprintOverlap(a, b) {
  const ox = Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2);
  const oz = Math.min(a.z + a.d / 2, b.z + b.d / 2) - Math.max(a.z - a.d / 2, b.z - b.d / 2);
  return ox > 0 && oz > 0 ? ox * oz : 0;
}

// ---------------- what is actually holding this up ----------------
// Nothing here reads a declaration: support is measured by looking down from
// each element's underside at what is physically there, then walking that
// chain to the ground.
export function supportAnalysis(masses) {
  const info = new Map();
  for (const m of masses) {
    const area = Math.max(0.01, m.w * m.d);
    if (m.y <= CONTACT_GAP) {
      info.set(m.id, { onGround: true, carriers: [], coverage: 1, area });
      continue;
    }
    const carriers = [];
    let covered = 0;
    for (const c of masses) {
      if (c === m || c.kind === 'void') continue;
      const top = c.y + c.h;
      if (Math.abs(top - m.y) > CONTACT_GAP && !(c.y < m.y && top > m.y + 0.01)) continue;
      const ov = footprintOverlap(m, c);
      if (ov <= 0.01) continue;
      carriers.push({ id: c.id, area: ov });
      covered += ov;
    }
    carriers.sort((a, b) => b.area - a.area);
    info.set(m.id, { onGround: false, carriers, coverage: Math.min(1, covered / area), area });
  }
  const grounded = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of masses) {
      if (grounded.has(m.id)) continue;
      const it = info.get(m.id);
      if (it.onGround || it.carriers.some(c => grounded.has(c.id))) { grounded.add(m.id); changed = true; }
    }
  }
  for (const m of masses) info.get(m.id).grounded = grounded.has(m.id);
  return info;
}

// How much of the building rides on each element: walk every element's mass
// down its primary carrier chain. An error in something carrying 60% of the
// assembly outranks the same error in a fin carrying nothing.
function loadFractions(masses, info) {
  const carried = new Map(masses.map(m => [m.id, 0]));
  let total = 0;
  for (const m of masses) {
    if (m.kind === 'void') continue;
    const v = m.w * m.d * m.h * (m.repeat ? m.repeat.count : 1);
    total += v;
    let cur = m, guard = 0;
    while (guard++ < 40) {
      carried.set(cur.id, (carried.get(cur.id) || 0) + v);
      const it = info.get(cur.id);
      if (!it || it.onGround || !it.carriers.length) break;
      const next = masses.find(x => x.id === it.carriers[0].id);
      if (!next) break;
      cur = next;
    }
  }
  const frac = new Map();
  for (const [id, v] of carried) frac.set(id, total ? v / total : 0);
  return frac;
}

// ---------------- the checks ----------------
// Each finding: { rule, severity, domain, where, issue, fix, why, conf, cost }
//   conf: 1.0 = geometric fact · ~0.5 = proportion heuristic (say so in why)
//   cost: 4 = envelope/system must change · 3 = adds a named element
//         2 = resize/move one element · 1 = fix the model, not the building

function allChecks(masses, metrics, site) {
  const F = [];
  const f = (rule, severity, domain, where, issue, fix, why, conf, cost) =>
    F.push({ rule, severity, domain, where, issue, fix, why, conf, cost });
  if (!masses?.length) return F;

  const info = supportAnalysis(masses);
  const byId = new Map(masses.map(m => [m.id, m]));
  const solids = masses.filter(m => m.kind !== 'void');

  for (const m of solids) {
    const tier = tierOf(m);
    const it = info.get(m.id);

    // ---- support facts: every tier, because floating is floating ----
    if (!it.onGround) {
      if (!it.carriers.length) {
        f('float', 'blocker', 'structure', m.id,
          `floats ${m.y.toFixed(1)} m up with nothing beneath it`,
          'put it on something, or bring something under it',
          `Looking straight down from this element's underside, no other solid is within ${CONTACT_GAP} m or passing through that level. It declares "${m.on || 'ground'}", but nothing is there — geometry outranks the label. Rigid-body fact.`, 1.0, 2);
        continue;
      }
      if (!it.grounded) {
        f('chain', 'blocker', 'structure', m.id,
          `rests on ${it.carriers.map(c => c.id).join(', ')}, which reaches nothing solid`,
          'ground the chain beneath it',
          'Support was traced element by element and never reached grade — whatever holds this up is itself unsupported. Rigid-body fact.', 1.0, 2);
        continue;
      }
      // a void carries nothing: it is subtracted material
      if (it.carriers.every(c => byId.get(c.id)?.kind === 'void')) {
        f('void-support', 'blocker', 'structure', m.id,
          'the only thing under it is a void',
          'land it on a solid, or fill the void beneath it',
          'A void is subtracted material — an absence cannot bear load. Rigid-body fact.', 1.0, 2);
      }
      // resultant off the support: the check that actually distinguishes a
      // buildable overhang from an unbuildable one (replaces the old
      // contact-area complaint, which merely described cantilevers)
      const sup = byId.get(it.carriers[0].id);
      if (sup && tier !== 'detail') {
        const ex = Math.abs(m.x - sup.x) / Math.max(0.5, sup.w / 2);
        const ez = Math.abs(m.z - sup.z) / Math.max(0.5, sup.d / 2);
        if (Math.max(ex, ez) > 1.0) {
          f('resultant', 'blocker', 'structure', m.id,
            `its weight lands outside ${sup.id} entirely`,
            'centre it over the support, or add a second one',
            `The centroid of this element sits ${Math.max(ex, ez) > 1 ? 'beyond' : 'at'} the edge of the only thing carrying it. Statics: a load whose resultant falls outside its support rotates off it. Rigid-body fact.`, 1.0, 2);
        }
        // cantilever proportion — ACI deemed-to-satisfy: beam l/8, slab l/10
        const reach = Math.max(
          (m.x + m.w / 2) - (sup.x + sup.w / 2), (sup.x - sup.w / 2) - (m.x - m.w / 2),
          (m.z + m.d / 2) - (sup.z + sup.d / 2), (sup.z - sup.d / 2) - (m.z - m.d / 2), 0);
        const limit = m.kind === 'slab' ? 10 : 8;
        if (reach > 0.5 && m.h > 0.05 && reach / m.h > limit) {
          f('cantilever', reach / m.h > limit * 2 ? 'blocker' : 'major', 'structure', m.id,
            `cantilevers ${reach.toFixed(1)} m on a ${m.h.toFixed(1)} m depth — ${(reach / m.h).toFixed(0)}:1 against a ${limit}:1 rule`,
            `deepen it to ~${(reach / limit).toFixed(1)} m, pull it back, or accept a visible transfer`,
            `Proportion heuristic, not analysis: ACI 318's deemed-to-satisfy minimum depth is span/${limit} for a concrete ${m.kind === 'slab' ? 'cantilever slab (Table 7.3.1.1)' : 'cantilever beam (Table 9.3.1.1)'}. The real structure is unknown at massing; treat this as advice about proportions.`, 0.5, 3);
        }
        // transfer trigger — the chain passes through a slab or member
        if ((sup.kind === 'slab' || sup.kind === 'member') && tier === 'primary') {
          f('transfer', 'major', 'structure', m.id,
            `a primary mass carried by a ${sup.kind} (${sup.id})`,
            'land it on a volume, or name the transfer structure',
            'ASCE 7 §12.3.3.3: elements supporting discontinuous walls or frames take amplified seismic design forces — a transfer is a named, costly component, not an accident.', 0.9, 3);
        }
      }
    }

    // Texture is exempt from structural proportion rules; a canopy or a
    // cantilevered slab is not — those are the elements that most often float
    // in a reading, and they are exactly what a reviewer would query.
    if (tier === 'detail') continue;

    // ---- habitability facts and heuristics: primary volumes ----
    if (tier === 'primary' && m.kind === 'volume') {
      const storeys = m.storeys || Math.max(1, Math.round(m.h / 3.2));
      const ff = m.h / storeys;
      if (ff < 2.6) {
        f('headroom', 'blocker', 'code', m.id,
          `${ff.toFixed(2)} m floor-to-floor over ${storeys} storey${storeys > 1 ? 's' : ''} — below what a ceiling can clear`,
          'fewer storeys in this height, or more height',
          'IBC §1208.2 requires 2286 mm clear in occupiable rooms; with any structure and finish at all, floor-to-floor under ~2.6 m is physically impossible. Hard code minimum.', 1.0, 4);
      }
      const depth = Math.min(m.w, m.d);
      if (depth > 24) {
        f('daylight', 'major', 'code', m.id,
          `${depth.toFixed(0)} m plan depth — the middle is beyond daylight from either side`,
          'cut a court or atrium through it, or split the volume',
          'Daylit depth from one facade runs ~2–2.5× the window head height (Lynes rule; ASHRAE 90.1 is stricter). Double-aspect plates work to ~13.5 m naturally lit (SteelConstruction.info); at twice that, the core of the plan is permanently electric-lit. Heuristic — deep plans are legal, just costly.', 0.6, 4);
      } else if (depth > 13.5) {
        f('daylight', 'minor', 'code', m.id,
          `${depth.toFixed(0)} m plan depth — past the naturally-lit limit`,
          'interior uses only at the centre',
          'Naturally lit and ventilated office plates run to about 13.5 m (SteelConstruction.info). Beyond that the middle band needs electric light all day. Heuristic.', 0.6, 2);
      }
      // egress lower bound: emitted only when NO core layout could save it
      const halfDiag = Math.hypot(m.w, m.d) / 2;
      const limitM = 91.4;   // IBC Table 1017.2, Group B sprinklered (300 ft)
      if (halfDiag > limitM) {
        f('egress', 'blocker', 'code', m.id,
          `~${halfDiag.toFixed(0)} m from centre to edge — beyond any permissible travel distance`,
          'this plate must be split; no stair layout rescues it',
          `Half the plan diagonal is the shortest possible worst-case travel path, whatever the core layout. IBC Table 1017.2 allows at most ${limitM} m (Group B, sprinklered). When even the lower bound exceeds the limit, the plate itself is the problem. Geometric fact about a code number.`, 0.9, 4);
      }
    }

    // slenderness: primary volumes only — a member's plan size is line weight
    if (tier === 'primary' && m.kind === 'volume') {
      const slender = m.h / Math.max(0.1, Math.min(m.w, m.d));
      if (slender > 14) {
        f('slender', 'major', 'structure', m.id,
          `slenderness ${slender.toFixed(0)}:1`,
          'thicken the plan, brace it, or lower it',
          'Proportion heuristic: habitable towers rarely stand past ~10–12:1 without outriggers or a heavy core, and nothing at massing stage says which this has.', 0.5, 3);
      }
    }
  }

  // ---- assembly facts: exactly one finding each, ever ----
  if (solids.length > 1) {
    const info2 = info;
    let vol = 0, cx = 0, cz = 0;
    for (const m of solids) { const v = m.w * m.d * m.h; vol += v; cx += m.x * v; cz += m.z * v; }
    cx /= vol || 1; cz /= vol || 1;
    const feet = solids.filter(m => info2.get(m.id).onGround);
    if (feet.length) {
      const minX = Math.min(...feet.map(m => m.x - m.w / 2)), maxX = Math.max(...feet.map(m => m.x + m.w / 2));
      const minZ = Math.min(...feet.map(m => m.z - m.d / 2)), maxZ = Math.max(...feet.map(m => m.z + m.d / 2));
      const outX = cx < minX ? minX - cx : cx > maxX ? cx - maxX : 0;
      const outZ = cz < minZ ? minZ - cz : cz > maxZ ? cz - maxZ : 0;
      const out = Math.hypot(outX, outZ);
      if (out > 0.01) {
        f('overturn', 'blocker', 'structure', 'building',
          `centre of mass falls ${out.toFixed(1)} m outside everything touching the ground`,
          'widen the base, or bring the upper mass back over it',
          'A body whose centre of mass sits outside its base overturns — no structure inside the building prevents it, only a wider foundation or ballast. Rigid-body fact.', 1.0, 4);
      }
    }
    // vertical geometric irregularity (ASCE 7 Table 12.3-2 Type 3): a storey
    // more than 1.3× the width of the one carrying it
    for (const m of solids) {
      const it = info2.get(m.id);
      if (it.onGround || !it.carriers.length || tierOf(m) !== 'primary') continue;
      const sup = byId.get(it.carriers[0].id);
      if (sup && tierOf(sup) === 'primary' && Math.max(m.w / sup.w, m.d / sup.d) > 1.3) {
        f('irregular', 'minor', 'structure', m.id,
          `${Math.max(m.w / sup.w, m.d / sup.d).toFixed(1)}× wider than ${sup.id} below it`,
          'expect the seismic design to treat this as a vertical irregularity',
          'ASCE 7 Table 12.3-2 Type 3: a lateral-system dimension over 130% of the adjacent storey is a vertical geometric irregularity. The threshold is genuinely geometric, so it applies even to boxes.', 0.9, 2);
      }
    }
  }

  // ---- what a reviewer would raise, beyond errors ----
  // The point of a review is not a clean bill of health; it is perspective.
  // These read the scheme as a whole and say what is true about it, whether or
  // not it is a fault.
  const prim = solids.filter(m => tierOf(m) === 'primary' && m.kind === 'volume');
  if (prim.length) {
    const top = Math.max(...solids.map(m => m.y + m.h));
    const xs = solids.flatMap(m => [m.x - m.w / 2, m.x + m.w / 2]);
    const zs = solids.flatMap(m => [m.z - m.d / 2, m.z + m.d / 2]);
    const foot = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...zs) - Math.min(...zs));
    let gfa = 0, envelope = 0, vol = 0, glazed = 0;
    for (const m of prim) {
      const st = m.storeys || Math.max(1, Math.round(m.h / 3.4));
      gfa += m.w * m.d * st;
      envelope += 2 * (m.w + m.d) * m.h + m.w * m.d;
      vol += m.w * m.d * m.h;
      if (m.facade === 'glass') glazed += 2 * (m.w + m.d) * m.h;
    }

    // compactness — the single number behind both heating and cooling load
    const sv = envelope / Math.max(1, vol);
    if (sv > 0.55) {
      f('compact', 'major', 'climate', 'building',
        `surface-to-volume ${sv.toFixed(2)} — a very exposed form`,
        'fewer, deeper volumes, or accept the envelope cost',
        `Every m² of skin is heat lost in winter and gained in summer. Compact blocks sit near 0.25\u20130.35 m\u207b\u00b9; above ~0.55 the envelope dominates the energy result no matter how good the glazing spec is. Heuristic, but it is the number that governs.`, 0.7, 3);
    } else if (sv > 0.4) {
      f('compact', 'minor', 'climate', 'building',
        `surface-to-volume ${sv.toFixed(2)}`,
        'watch the envelope spec, or consolidate the volumes',
        'Moderately articulated form: more skin than a simple block, which shows up in both the heating and cooling loads. Heuristic.', 0.7, 2);
    }

    // glazing share — the cheapest lever on the energy line
    const glazeShare = envelope > 0 ? glazed / envelope : 0;
    if (glazeShare > 0.55) {
      f('glazing', 'major', 'climate', 'building',
        `about ${(glazeShare * 100).toFixed(0)}% of the envelope is fully glazed`,
        'move a volume or two to slats-v or solid',
        `Fully-glazed volumes make up most of the skin here. Beyond roughly half, glazing drives cooling load and glare faster than any other massing decision, and it is the cheapest thing to change at this stage. Heuristic.`, 0.7, 2);
    }

    // plot ratio, when there is a real parcel to measure against
    if (site?.parcelAreaM2 > 10) {
      const far = gfa / site.parcelAreaM2;
      const cover = foot / site.parcelAreaM2;
      if (cover > 0.7) {
        f('coverage', 'major', 'code', 'building',
          `the building covers about ${(cover * 100).toFixed(0)}% of the parcel you drew`,
          'pull the footprint in, or extend the parcel',
          `Site coverage over ~70% leaves almost no room for setbacks, servicing, fire access or landscape, all of which most jurisdictions require. Measured against your own drawn parcel.`, 0.8, 4);
      }
      f('far', 'note', 'code', 'building',
        `plot ratio ${far.toFixed(2)} \u2014 ${Math.round(gfa)} m\u00b2 on ${Math.round(site.parcelAreaM2)} m\u00b2 of land`,
        'check this against the zoning for the district',
        `Gross floor area divided by parcel area, both measured from your model and your drawn boundary. This is the number a planning department opens the file with; it is not a fault, it is the fact the whole application turns on.`, 0.9, 0);
    }

    // storeys and floor-to-floor, as an observation
    const totalStoreys = prim.reduce((a, m) => Math.max(a, (m.storeys || 1) + Math.round(m.y / 3.4)), 0);
    f('summary', 'note', 'structure', 'building',
      `${prim.length} primary mass${prim.length > 1 ? 'es' : ''}, ${totalStoreys} storey${totalStoreys > 1 ? 's' : ''}, ${top.toFixed(1)} m to the top, ${Math.round(gfa)} m\u00b2 gross`,
      '',
      `What the model actually contains, measured rather than assumed \u2014 the starting point for every other reading on this page.`, 1.0, 0);
  }

  // ---- climate: unchanged benchmarks ----
  if (metrics) {
    const carbon = +metrics.carbon || 0, energy = +metrics.eui || 0;
    if (carbon > 800) f('carbon', 'major', 'climate', 'building', `${carbon.toFixed(0)} kgCO₂e/m² embodied — well over common 2030 targets (~600)`, 'timber structure, less transfer, more repetition', 'Benchmark comparison against published embodied-carbon targets for the type.', 0.7, 3);
    else if (carbon > 620) f('carbon', 'minor', 'climate', 'building', `${carbon.toFixed(0)} kgCO₂e/m² embodied`, 'the structure line in the dashboard is where it hides', 'Benchmark comparison.', 0.7, 2);
    if (energy > 160) f('energy', 'major', 'climate', 'building', `${energy.toFixed(0)} kWh/m²y — roughly double a good envelope`, 'compactness and glazing ratio first', 'Benchmark comparison against typical good-practice EUI for the type.', 0.7, 3);
    else if (energy > 110) f('energy', 'minor', 'climate', 'building', `${energy.toFixed(0)} kWh/m²y operational`, 'consider the surface-to-volume ratio', 'Benchmark comparison.', 0.7, 2);
  }

  // context height, when a real neighbourhood exists
  if (site?.buildings?.length) {
    const top = Math.max(...solids.map(m => m.y + m.h));
    const hs = site.buildings.map(b => b.h).sort((a, b) => a - b);
    const tallest = hs[hs.length - 1];
    if (top > tallest * 1.6) {
      f('context', 'major', 'code', 'building',
        `${top.toFixed(0)} m against a tallest neighbour of ${tallest.toFixed(0)} m`,
        'step the upper storeys back or down',
        `Graded against the ${site.buildings.length} measured buildings around the pinned site — contextual-height review territory in most jurisdictions. Advisory.`, 0.7, 3);
    }
  }
  return F;
}

// ---------------- grouping and ranking ----------------
// One authored decision, one finding. Root causes swallow their consequences.
// Rank by what the error costs × how much rides on it × how sure the check is.

function groupAndRank(findings, masses) {
  const info = supportAnalysis(masses || []);
  const mfrac = masses?.length ? loadFractions(masses, info) : new Map();
  const byId = new Map((masses || []).map(m => [m.id, m]));

  // prototype collapse: same rule on elements of the same kind/role/size is
  // one decision repeated, not many findings
  const groups = new Map();
  for (const x of findings) {
    const m = byId.get(x.where);
    const proto = m ? [x.rule, m.kind, m.role, Math.round(m.w * 5), Math.round(m.h * 5)].join('|') : x.rule + '|' + x.where;
    if (!groups.has(proto)) groups.set(proto, { ...x, count: 1, others: [] });
    else { const g = groups.get(proto); g.count++; g.others.push(x.where); }
  }
  let out = [...groups.values()].map(g => g.count > 1
    ? { ...g, issue: `${g.count}× ${g.issue}`, where: g.where, fix: g.fix }
    : g);

  // root-cause collapse: a blocker on a support swallows findings on what it
  // carries — fix the cause, the consequences follow
  const blocked = new Set(out.filter(x => x.severity === 'blocker' && ['float', 'chain'].includes(x.rule)).map(x => x.where));
  if (blocked.size) {
    out = out.filter(x => {
      if (blocked.has(x.where)) return true;
      const it = info.get(x.where);
      const dependsOnBlocked = it?.carriers?.some(c => blocked.has(c.id));
      return !dependsOnBlocked || ['float', 'chain'].includes(x.rule);
    });
  }

  const rank = { blocker: 0, major: 1, minor: 2, note: 3 };
  for (const x of out) {
    const lf = mfrac.get(x.where) ?? 0.15;
    x.priority = (x.cost || 2) * (0.3 + 0.7 * lf) * (x.conf || 0.6) * (3 - rank[x.severity]);
  }
  // notes always sit below findings, however interesting they are
  out.sort((a, b) => (rank[a.severity] > 2) - (rank[b.severity] > 2)
    || b.priority - a.priority || rank[a.severity] - rank[b.severity]);
  // the primary view holds a handful of decisions; the rest fold away
  out.forEach((x, i) => { x.folded = i >= 7 && x.severity !== 'note'; });
  return out;
}

// ---------------- the review table ----------------

export const REVIEWERS = [
  { id: 'structure', name: 'Priya', role: 'Structural engineer',
    domains: ['structure'], accent: '#c1553f',
    quiet: 'It stands up \u2014 every mass reaches the ground and nothing needs a transfer. At this stage that is all the geometry can tell you; spans and depths are still guesses.' },
  { id: 'planner', name: 'Marcus', role: 'Planning officer',
    domains: ['code'], accent: '#4a6fa5',
    quiet: 'Nothing here would stop a planning submission on massing grounds. Height, plate depth and travel distances all sit inside the usual limits.' },
  { id: 'sustainability', name: 'Lena', role: 'Sustainability lead',
    domains: ['climate'], accent: '#4a9d5b',
    quiet: 'Carbon, energy, compactness and glazing all sit inside the benchmarks for this type.' },
];

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

// What to actually change, in the language of the sliders on screen.
export function optimisationAdvice(findings, masses, metrics) {
  if (!masses?.length) return [];
  const out = [];
  const seen = new Set();
  const add = a => { const k = a.what + a.target; if (!seen.has(k)) { seen.add(k); out.push(a); } };
  const byId = new Map(masses.map(m => [m.id, m]));

  for (const x of findings) {
    const m = byId.get(x.where);
    if (x.rule === 'slender' && m) {
      const need = +(m.h / 10).toFixed(1);
      const grow = +(need - Math.min(m.w, m.d)).toFixed(1);
      if (grow > 0.1) add({ target: x.where, what: (m.w <= m.d ? 'w' : 'd'), severity: x.severity,
        text: `Widen ${x.where}'s ${m.w <= m.d ? 'width' : 'depth'} by ${grow} m (to ${need} m) — slenderness comes back to 10:1.` });
    }
    if ((x.rule === 'resultant' || x.rule === 'cantilever' || x.rule === 'float') && m) {
      const sup = byId.get(m.on) || null;
      if (sup) {
        const toward = +(sup.x - m.x).toFixed(1);
        if (Math.abs(toward) > 0.3) add({ target: x.where, what: 'x', severity: x.severity,
          text: `Slide ${x.where} ${toward > 0 ? 'right' : 'left'} by ${Math.abs(toward).toFixed(1)} m to sit over ${sup.id} — or name the transfer that carries it.` });
      }
    }
    if (x.rule === 'daylight' && m) {
      const cut = +(Math.min(m.w, m.d) - 13.5).toFixed(1);
      if (cut > 0.5) add({ target: x.where, what: (m.w <= m.d ? 'w' : 'd'), severity: x.severity,
        text: `Take ${cut} m off ${x.where}'s ${m.w <= m.d ? 'width' : 'depth'}, or cut a court through it — daylight runs out 13.5 m in.` });
    }
    if (x.rule === 'headroom' && m) add({ target: x.where, what: 'storeys', severity: x.severity,
      text: `${x.where} holds ${m.storeys} storeys in ${m.h.toFixed(1)} m — drop one storey or raise it to ${(m.storeys * 3.0).toFixed(1)} m.` });
    if (x.rule === 'carbon') add({ target: 'building', what: 'structure', severity: x.severity,
      text: `Switch the structure to timber-hybrid in Params — typically 25-40% off upfront carbon before any geometry changes.` });
    if (x.rule === 'energy') {
      const glassy = masses.filter(v => v.facade === 'glass').length;
      add({ target: 'building', what: 'facade', severity: x.severity,
        text: glassy
          ? `${glassy} volume${glassy > 1 ? 's are' : ' is'} fully glazed — moving one or two to slats-v or solid is the cheapest move on the energy line.`
          : `Compactness governs here: fewer, deeper volumes lower the surface-to-volume ratio.` });
    }
  }
  const rank = { blocker: 0, major: 1, minor: 2, note: 3 };
  out.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return out.slice(0, 6);
}

// ---------------- the audit ----------------

export function runAudit({ masses, metrics, site }) {
  const raw = allChecks(masses, metrics, site);
  const findings = groupAndRank(raw, masses);
  const counts = { blocker: 0, major: 0, minor: 0, note: 0 };
  for (const x of findings) counts[x.severity]++;
  const rank = { blocker: 0, major: 1, minor: 2, note: 3 };
  const worstByElement = {};
  for (const x of findings) {
    if (x.where === 'building' || x.severity === 'note') continue;
    if (!(x.where in worstByElement) || rank[x.severity] < rank[worstByElement[x.where]]) worstByElement[x.where] = x.severity;
  }
  const table = REVIEWERS.map(r => ({
    ...r,
    findings: findings.filter(x => r.domains.includes(x.domain)),
  }));
  return { findings, counts, worstByElement, table,
    advice: optimisationAdvice(findings, masses, metrics),
    clean: findings.length === 0 };
}
