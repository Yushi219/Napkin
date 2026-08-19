// Metrics engine: schematic-stage proxies with visible sources. Program type
// drives loads, rates and baselines — an office and a laboratory are different
// buildings even with the same silhouette.
import { state, towerStats } from './model.js';
import { getSite, winterNoonAlt } from './solar.js';

export const TYPES = {
  office:      { label: 'Office',      fh: 3.6, cost: 2600, eui0: 120, carbonF: 1.00, occ: 12,  note: 'open workplace, med. services' },
  laboratory:  { label: 'Laboratory',  fh: 4.4, cost: 4300, eui0: 320, carbonF: 1.22, occ: 22,  note: 'high ventilation + vibration control' },
  residential: { label: 'Residential', fh: 3.1, cost: 2300, eui0: 58,  carbonF: 0.92, occ: 28,  note: 'compartmented plans, operable windows' },
  hotel:       { label: 'Hotel',       fh: 3.3, cost: 3000, eui0: 130, carbonF: 0.98, occ: 24,  note: '24/7 occupancy, high hot water' },
  school:      { label: 'School',      fh: 3.8, cost: 2500, eui0: 90,  carbonF: 1.02, occ: 6,   note: 'daylight-critical, assembly loads' },
  museum:      { label: 'Museum',      fh: 5.2, cost: 4100, eui0: 145, carbonF: 1.14, occ: 18,  note: 'tall galleries, tight climate + light control' },
};
const CUSTOM_HINTS = [
  [/museum|gallery|exhibit|kunsthal|art centre|art center/i, 'museum'],
  [/lab|research|pharma|biotech|clean/i, 'laboratory'],
  [/resi|apart|housing|condo|dorm|live/i, 'residential'],
  [/hotel|hostel|inn|resort/i, 'hotel'],
  [/school|edu|campus|univer|kinder/i, 'school'],
  [/farm|grow|greenhouse/i, 'laboratory'],
];
export function resolveType(key, customText = '') {
  if (key !== 'custom') return { key, base: TYPES[key], custom: null };
  for (const [re, k] of CUSTOM_HINTS) if (re.test(customText)) return { key: k, base: TYPES[k], custom: customText };
  return { key: 'office', base: TYPES.office, custom: customText };
}

const LOT_AREA = 3600;         // m²
const DISTRICT = { name: 'Boston High Spine', capFt: 400, maxFAR: 13 };
const STRUCT_CARBON = { concrete: 620, steel: 510, 'timber-hybrid': 380 };

export function compute(customText = '') {
  const st = towerStats();
  const t = resolveType(state.type, customText).base;

  const heightFt = st.height * 3.281;
  const far = st.gfa / LOT_AREA;
  const envelopeRatio = st.facade / Math.max(st.gfa, 1);

  const carbon = STRUCT_CARBON[state.structure] * t.carbonF * (1 + Math.abs(state.twist) / 45 * 0.05);
  const cost = st.gfa * t.cost * (1 + Math.abs(state.twist) / 45 * 0.07) / 1e6;
  const slender = st.height / Math.max(st.minPlan, 1);
  const util = Math.min(135, 20 + slender * 7.5 + Math.abs(state.twist) / 45 * 14 + (state.structure === 'timber-hybrid' ? 8 : 0));
  // site-aware: a deep plate in Singapore is not the same building as in Malmö.
  // Low winter sun (high latitude) makes daylight harder and heating heavier.
  const site = getSite();
  const winterAlt = winterNoonAlt(site) * 180 / Math.PI;      // degrees
  const latPenalty = (45 - Math.min(winterAlt, 45)) * 0.42;    // 0 at 45°, ~19 at 0°
  const daylight = Math.max(5, Math.min(98,
    82 - (st.plateDepth - 20) * 1.8 + (1 - state.taper) * 18 + state.segments.length * 3 - latPenalty));
  const climate = 1 + (Math.abs(site.lat) - 42) * 0.004 + (Math.abs(site.lat) < 25 ? 0.10 : 0);
  const eui = t.eui0 * (0.82 + envelopeRatio * 0.55) * climate - (state.greenRoof ? 4 : 0);
  const occupants = Math.round(st.gfa / t.occ);

  // LEED v4 BD+C estimate (documented proxy)
  const euiBaseline = t.eui0 * 1.15;
  const energySave = Math.max(0, (euiBaseline - eui) / euiBaseline);
  const leedEnergy = Math.min(18, Math.floor(energySave / 0.03));
  const leedDaylight = daylight >= 75 ? 3 : daylight >= 60 ? 2 : daylight >= 50 ? 1 : 0;
  const leedHeat = state.greenRoof ? 2 : 0;
  const leedMR = state.structure === 'timber-hybrid' ? 3 : 0;
  const leedBase = 22; // LT(8) urban+transit site, WE(4), EA fundamentals+cx(6), IN(2), RP(2)
  const leed = leedBase + leedEnergy + leedDaylight + leedHeat + leedMR;
  const tier = leed >= 80 ? 'Platinum' : leed >= 60 ? 'Gold' : leed >= 50 ? 'Silver' : leed >= 40 ? 'Certified' : 'Below certification';

  return {
    stats: st, type: t,
    heightFt, far, carbon, cost, util, daylight, eui, occupants,
    leed, tier, leedParts: { base: leedBase, energy: leedEnergy, daylight: leedDaylight, heat: leedHeat, mr: leedMR },
    energySave,
  };
}

const fmtInt = v => Math.round(v).toLocaleString();

export const METRIC_DEFS = [
  {
    id: 'height', label: 'Height', unit: 'ft',
    val: m => fmtInt(m.heightFt),
    status: m => m.heightFt > DISTRICT.capFt ? 'bad' : m.heightFt > DISTRICT.capFt * 0.92 ? 'warn' : 'ok',
    pop: m => ({
      title: 'Height vs zoning cap',
      value: `${fmtInt(m.heightFt)} ft of ${DISTRICT.capFt} ft allowed`,
      body: `${state.floors} floors × ${state.floorHeight} m. The ${DISTRICT.name} district caps towers at ${DISTRICT.capFt} ft; above it you are in variance territory.`,
      formula: `height = floors × floorHeight = ${state.floors} × ${state.floorHeight} m = ${fmtInt(m.stats.height)} m`,
      source: 'Boston Zoning Code, Article 13 — district height regulations',
    }),
  },
  {
    id: 'far', label: 'FAR', unit: '',
    val: m => m.far.toFixed(1),
    status: m => m.far > DISTRICT.maxFAR ? 'bad' : m.far > DISTRICT.maxFAR * 0.9 ? 'warn' : 'ok',
    pop: m => ({
      title: 'Floor area ratio',
      value: `${m.far.toFixed(2)} of ${DISTRICT.maxFAR} allowed`,
      body: `Gross floor area ${fmtInt(m.stats.gfa)} m² on a ${fmtInt(LOT_AREA)} m² lot. FAR is the density currency of zoning — exceed it and no beauty will save you.`,
      formula: `FAR = GFA / lot = ${fmtInt(m.stats.gfa)} / ${fmtInt(LOT_AREA)}`,
      source: 'Boston Zoning Code, Article 13 — FAR by district',
    }),
  },
  {
    id: 'gfa', label: 'Area', unit: 'm²',
    val: m => fmtInt(m.stats.gfa),
    status: () => 'ok',
    pop: m => ({
      title: 'Gross floor area',
      value: `${fmtInt(m.stats.gfa)} m² · ~${fmtInt(m.occupants)} occupants`,
      body: `Sum of every plate. Occupancy assumes ${m.type.occ} m² per person for ${m.type.label.toLowerCase()} (${m.type.note}).`,
      formula: `GFA = Σ plateArea(f) · occupants = GFA / ${m.type.occ}`,
      source: 'Occupant density: ASHRAE 62.1 / BOMA typical program loads',
    }),
  },
  {
    id: 'carbon', label: 'Carbon', unit: 'kg/m²',
    val: m => fmtInt(m.carbon),
    status: m => m.carbon > 640 ? 'bad' : m.carbon > 560 ? 'warn' : 'ok',
    pop: m => ({
      title: 'Embodied carbon intensity',
      value: `${fmtInt(m.carbon)} kgCO₂e/m² (budget 640)`,
      body: `${state.structure} frame, ${m.type.label.toLowerCase()} program factor ×${m.type.carbonF}. Twist premium ${Math.round(Math.abs(state.twist) / 45 * 5)}%. Say “use timber” in the chat to see it fall.`,
      formula: `carbon = structureFactor(${STRUCT_CARBON[state.structure]}) × programFactor(${m.type.carbonF}) × twistPremium`,
      source: 'CLF Embodied Carbon Benchmark Study (structure A1–A3 ranges)',
    }),
  },
  {
    id: 'cost', label: 'Cost', unit: '',
    val: m => '$' + fmtInt(m.cost) + 'M',
    status: () => 'ok',
    pop: m => ({
      title: 'Construction cost',
      value: `$${fmtInt(m.cost)}M · $${fmtInt(m.type.cost)}/m² base rate`,
      body: `${m.type.label} shell-and-core rate, Boston market. A laboratory costs ~65% more per square metre than an office — program is destiny.`,
      formula: `cost = GFA × rate(${m.type.cost} $/m²) × twistPremium`,
      source: 'RSMeans / Turner index, program-adjusted (schematic proxy)',
    }),
  },
  {
    id: 'util', label: 'Structure', unit: '%',
    val: m => fmtInt(m.util),
    status: m => m.util > 100 ? 'bad' : m.util > 88 ? 'warn' : 'ok',
    pop: m => ({
      title: 'Structural pre-check',
      value: `${fmtInt(m.util)}% utilization`,
      body: `Slenderness ${(m.stats.height / Math.max(m.stats.minPlan, 1)).toFixed(1)} (height / narrowest plate). Past 100% this silhouette needs outriggers or a wider stance — the VIKTOR-style pre-check verdict.`,
      formula: `util = 20 + slenderness × 7.5 + twist/45 × 14 + timberPenalty`,
      source: 'Engineering proxy — drift-governed slenderness heuristic',
    }),
  },
  {
    id: 'daylight', label: 'Daylight', unit: '/100',
    val: m => fmtInt(m.daylight),
    status: m => m.daylight < 45 ? 'bad' : m.daylight < 60 ? 'warn' : 'ok',
    pop: m => ({
      title: 'Daylight potential',
      value: `${fmtInt(m.daylight)} / 100`,
      body: `Driven by plate depth (${fmtInt(m.stats.plateDepth)} m): light dies ~7 m from glass. Taper and setbacks buy the upper floors sky.`,
      formula: `daylight = 82 − (plateDepth − 20) × 1.8 + taperBonus + stepBonus − latitudePenalty`,
      source: 'Proxy for LEED EQ Daylight / sDA300,50% intent',
    }),
  },
  {
    id: 'eui', label: 'Energy', unit: 'kWh/m²y',
    val: m => fmtInt(m.eui),
    status: m => m.eui > m.type.eui0 * 1.15 ? 'bad' : m.eui > m.type.eui0 ? 'warn' : 'ok',
    pop: m => ({
      title: 'Energy use intensity',
      value: `${fmtInt(m.eui)} vs ${m.type.label.toLowerCase()} baseline ${fmtInt(m.type.eui0 * 1.15)}`,
      body: `Program baseline × envelope ratio (${(m.stats.facade / m.stats.gfa).toFixed(2)} m² facade per m² floor). A lab burns ~2.7× an office before you draw a single line.`,
      formula: `EUI = baseline(${m.type.eui0}) × (0.82 + envelopeRatio × 0.55) − greenRoof`,
      source: 'CBECS medians by program; ASHRAE 90.1 baseline logic',
    }),
  },
  {
    id: 'leed', label: 'LEED', unit: 'pts',
    val: m => `${m.leed}`,
    status: m => m.leed >= 60 ? 'ok' : m.leed >= 40 ? 'warn' : 'bad',
    pop: m => ({
      title: `LEED v4 estimate — ${m.tier}`,
      value: `${m.leed} / 110 points`,
      body: `Base package ${m.leedParts.base} (urban site LT 8, water 4, EA fundamentals 6, innovation 2, regional 2) + energy ${m.leedParts.energy} (${Math.round(m.energySave * 100)}% under baseline) + daylight ${m.leedParts.daylight} + heat island ${m.leedParts.heat} + timber ${m.leedParts.mr}. Certified 40 · Silver 50 · Gold 60 · Platinum 80.`,
      formula: `points = base + EAc2(⌊save%/3⌋≤18) + EQ daylight + SSc5 + MR timber`,
      source: 'USGBC LEED v4 BD+C scorecard (schematic estimate, not a rating)',
    }),
  },
];
