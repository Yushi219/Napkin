// The real site. Everything here talks to open, keyless services and turns a
// street address into what the model needs: the surrounding buildings as
// measured footprints, the ground as measured elevations, the sky as the
// weather actually over the site, and the jurisdiction the code checks run
// under. This is the layer that makes the model mean something — a building
// is only right or wrong relative to a place.
//
//   Nominatim  (OpenStreetMap)  — place search
//   Overpass   (OpenStreetMap)  — building footprints + heights around the site
//   Open-Meteo                  — elevation grid, live weather, UTC offset
//
// All three allow browser CORS and modest, attributed use. Results are cached
// per site so a session asks each question once.

// ---------------- state ----------------

let activeSite = null;      // { lat, lon, radius, label, address, region }
const cache = new Map();

export function currentRealSite() { return activeSite; }
export function clearRealSite() { activeSite = null; }
export function setActiveSite(s) { activeSite = s; }

// ---------------- place search ----------------

export async function searchPlaces(q) {
  if (!q || q.trim().length < 2) return [];
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&accept-language=en&q=' + encodeURIComponent(q.trim());
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('place search ' + res.status);
  const rows = await res.json();
  return rows.map(r => ({
    label: r.display_name,
    lat: +r.lat, lon: +r.lon,
    kind: r.type,
    address: r.address || {},
  }));
}

// The jurisdiction, as well as geocoding can tell it. The code checks are
// advisory heuristics tuned per region — named honestly in the UI, never
// presented as the legal code text.
export function regionOf(address = {}) {
  const country = address.country_code || '';
  const state = address.state || address.province || '';
  const city = address.city || address.town || address.municipality || '';
  return { country, state, city, label: [city, state].filter(Boolean).join(', ') || country.toUpperCase() };
}

// ---------------- context buildings (Overpass) ----------------

// local metres around the site centre: x east, z south (three.js z toward viewer)
export function toLocal(lat, lon, lat0, lon0) {
  const x = (lon - lon0) * Math.cos(lat0 * Math.PI / 180) * 111320;
  const z = (lat0 - lat) * 110540;
  return [x, z];
}

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

// point-in-polygon, local metres — the parcel test
export function pointInPoly([px, pz], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// A street is not a building. One Overpass round-trip brings back the whole
// scene: buildings, the road network with its classes and bridges, water as
// bodies and as rivers, and the green — parks, lawns, woods.
const ROAD_W = {
  motorway: 16, trunk: 14, primary: 12, secondary: 10, tertiary: 8,
  residential: 6, unclassified: 6, living_street: 5, service: 4,
  pedestrian: 3, footway: 2.2, cycleway: 2.5, path: 2,
};

export async function fetchContextFeatures(lat, lon, radius = 220) {
  const key = `feat:${lat.toFixed(5)},${lon.toFixed(5)},${radius}`;
  if (cache.has(key)) return cache.get(key);
  const R = Math.round(radius);
  const q = `[out:json][timeout:30];(
    way[building](around:${R},${lat},${lon});
    way[highway~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|service|pedestrian|footway|cycleway|path)$"](around:${R},${lat},${lon});
    way[waterway~"^(river|stream|canal|riverbank)$"](around:${R + 80},${lat},${lon});
    way[natural=water](around:${R + 80},${lat},${lon});
    way[natural=coastline](around:${R + 150},${lat},${lon});
    way[man_made=pier](around:${R + 60},${lat},${lon});
    way[leisure~"^(park|garden|pitch|playground|common)$"](around:${R},${lat},${lon});
    way[landuse~"^(grass|forest|meadow|recreation_ground|cemetery|village_green)$"](around:${R},${lat},${lon});
  );out geom 1200;`;
  let rows = null, lastErr = null;
  for (const host of OVERPASS) {
    try {
      const res = await fetch(host, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      if (!res.ok) { lastErr = new Error('overpass ' + res.status); continue; }
      rows = (await res.json()).elements || [];
      break;
    } catch (e) { lastErr = e; }
  }
  if (!rows) throw lastErr || new Error('overpass unreachable');

  const buildings = [], roads = [], water = [], green = [], coast = [], piers = [];
  for (const w of rows) {
    if (!w.geometry || w.geometry.length < 2) continue;
    const pts = w.geometry.map(g => toLocal(g.lat, g.lon, lat, lon));
    const t = w.tags || {};
    if (t.natural === 'coastline') {
      coast.push({ pts });
    } else if (t.man_made === 'pier') {
      if (pts.length >= 3) piers.push({ poly: pts });
      else roads.push({ pts, w: 4, bridge: false, kind: 'pier' });
    } else if (t.building) {
      if (pts.length < 3) continue;
      let h = parseFloat(t.height);
      if (!Number.isFinite(h)) {
        const lv = parseFloat(t['building:levels']);
        h = Number.isFinite(lv) ? lv * 3.2 : 8;
      }
      buildings.push({ poly: pts, h: Math.max(3, Math.min(320, h)), name: t.name || null });
    } else if (t.highway) {
      roads.push({ pts, w: ROAD_W[t.highway] || 5, bridge: t.bridge === 'yes' || !!t.bridge && t.bridge !== 'no', kind: t.highway });
    } else if (t.waterway === 'riverbank') {
      if (pts.length >= 3) water.push({ poly: pts, line: false });
    } else if (t.waterway) {
      water.push({ pts, line: true, w: Math.max(4, parseFloat(t.width) || (t.waterway === 'river' ? 20 : 5)) });
    } else if (t.natural === 'water') {
      if (pts.length >= 3) water.push({ poly: pts, line: false });
    } else if (t.leisure || t.landuse) {
      if (pts.length >= 3) green.push({ poly: pts });
    }
  }
  const out = { buildings, roads: roads.slice(0, 420), water: water.slice(0, 90), green: green.slice(0, 130), coast: coast.slice(0, 60), piers: piers.slice(0, 80) };
  cache.set(key, out);
  return out;
}

export async function fetchContextBuildings(lat, lon, radius = 220) {
  const key = `ctx:${lat.toFixed(5)},${lon.toFixed(5)},${radius}`;
  if (cache.has(key)) return cache.get(key);
  const q = `[out:json][timeout:25];(way[building](around:${Math.round(radius)},${lat},${lon}););out geom 400;`;
  let rows = null, lastErr = null;
  for (const host of OVERPASS) {
    try {
      const res = await fetch(host, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      if (!res.ok) { lastErr = new Error('overpass ' + res.status); continue; }
      rows = (await res.json()).elements || [];
      break;
    } catch (e) { lastErr = e; }
  }
  if (!rows) throw lastErr || new Error('overpass unreachable');

  const out = [];
  for (const w of rows) {
    if (!w.geometry || w.geometry.length < 3) continue;
    const poly = w.geometry.map(g => toLocal(g.lat, g.lon, lat, lon));
    // height: measured tag first, storeys second, a modest default last
    const t = w.tags || {};
    let h = parseFloat(t.height);
    if (!Number.isFinite(h)) {
      const lv = parseFloat(t['building:levels']);
      h = Number.isFinite(lv) ? lv * 3.2 : 8;
    }
    h = Math.max(3, Math.min(320, h));
    // centroid + oriented-ish box would lose the real shape; keep the polygon
    out.push({ poly, h, levels: t['building:levels'] || null, name: t.name || null });
  }
  cache.set(key, out);
  return out;
}

// ---------------- terrain (Open-Meteo elevation) ----------------

export async function fetchTerrainGrid(lat, lon, radius = 220, n = 7) {
  const key = `ter:${lat.toFixed(5)},${lon.toFixed(5)},${radius},${n}`;
  if (cache.has(key)) return cache.get(key);
  const lats = [], lons = [];
  const dLat = (radius / 110540), dLon = (radius / (111320 * Math.cos(lat * Math.PI / 180)));
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    lats.push((lat - dLat + (2 * dLat) * (j / (n - 1))).toFixed(5));
    lons.push((lon - dLon + (2 * dLon) * (i / (n - 1))).toFixed(5));
  }
  const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats.join(',')}&longitude=${lons.join(',')}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('elevation ' + res.status);
  const hs = (await res.json()).elevation || [];
  if (hs.length !== n * n) throw new Error('elevation grid incomplete');
  const centre = hs[Math.floor(n * n / 2)];
  // centreAbs keeps the absolute datum: sea level is absolute zero, and a
  // coastal scene needs to know where that is relative to the parcel.
  const grid = { n, radius, heights: hs.map(h => +(h - centre).toFixed(1)), centreAbs: +centre.toFixed(1) };
  cache.set(key, grid);
  return grid;
}

// bilinear sample of the grid at local metres (x east, z south)
export function terrainAt(grid, x, z) {
  if (!grid) return 0;
  const { n, radius, heights } = grid;
  const u = Math.max(0, Math.min(n - 1.001, ((x + radius) / (2 * radius)) * (n - 1)));
  const v = Math.max(0, Math.min(n - 1.001, ((z + radius) / (2 * radius)) * (n - 1)));
  const i = Math.floor(u), j = Math.floor(v);
  const fu = u - i, fv = v - j;
  const h00 = heights[j * n + i], h10 = heights[j * n + i + 1];
  const h01 = heights[(j + 1) * n + i], h11 = heights[(j + 1) * n + i + 1];
  return (h00 * (1 - fu) + h10 * fu) * (1 - fv) + (h01 * (1 - fu) + h11 * fv) * fv + 0;
}

// ---------------- live weather (Open-Meteo) ----------------

// WMO weather codes -> the app's own skies
const WMO_TO_SKY = [
  [[0], 'clear'], [[1], 'scattered'], [[2], 'cirrus'], [[3], 'overcast'],
  [[45, 48], 'fog'],
  [[51, 53, 55, 61, 63, 80, 81], 'shower'],
  [[65, 82, 95, 96, 99], 'storm'],
  [[71, 73, 75, 77, 85, 86], 'snow'],
];

export async function fetchLiveWeather(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,is_day,wind_speed_10m&timezone=auto`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('weather ' + res.status);
  const d = await res.json();
  const cur = d.current || {};
  let sky = 'clear';
  for (const [codes, k] of WMO_TO_SKY) if (codes.includes(cur.weather_code)) sky = k;
  if (!cur.is_day && sky === 'clear') sky = 'night';
  return {
    sky,
    tempC: cur.temperature_2m,
    windKmh: cur.wind_speed_10m,
    isDay: !!cur.is_day,
    utcOffsetHours: (d.utc_offset_seconds || 0) / 3600,
    timezone: d.timezone || null,
  };
}

// ---------------- one call that gathers a whole site ----------------

// parcel: [[lat,lon]…] as drawn on the map; converted to local metres here
export async function assembleSite({ lat, lon, radius, label, address, parcel }, onStep) {
  const region = regionOf(address);
  onStep?.('Fetching streets, water, parks and neighbours from OpenStreetMap…');
  let contextError = null;
  let features = await fetchContextFeatures(lat, lon, radius)
    .catch(e => { contextError = String(e.message || e); return { buildings: [], roads: [], water: [], green: [] }; });
  // A bare answer from a real query usually means a thinly-mapped area — widen
  // once before concluding there is nothing there.
  if (!contextError && features.buildings.length + features.roads.length < 4 && radius < 400) {
    onStep?.('Almost nothing mapped this close — widening the search to 400 m…');
    const wider = await fetchContextFeatures(lat, lon, 400).catch(() => null);
    if (wider && wider.buildings.length + wider.roads.length > features.buildings.length + features.roads.length) {
      features = wider; radius = 400;
    }
  }
  onStep?.(`${features.buildings.length} buildings, ${features.roads.length} road segments. Reading the ground…`);
  const terrain = await fetchTerrainGrid(lat, lon, radius).catch(e => { console.warn('terrain failed', e); return null; });
  onStep?.('Asking the sky over the site…');
  const weather = await fetchLiveWeather(lat, lon).catch(e => { console.warn('weather failed', e); return null; });
  const parcelLocal = parcel?.length >= 3 ? parcel.map(([la, lo]) => toLocal(la, lo, lat, lon)) : null;
  activeSite = { lat, lon, radius, label, address, region, ...features, terrain, weather, parcelLocal, contextError };
  return activeSite;
}
