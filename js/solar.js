// Real solar geometry. NOAA solar position equations (ported from the
// Solar Comfort Tool's solarCalculator.js, d3 dependency removed) driven by an
// explicit site: latitude, longitude, UTC offset and true-north convention.
//
// World convention used everywhere in NAPKIN:
//   +X = east, −Z = north, +Y = up. Azimuth is compass: 0° = N, 90° = E.

const J2000 = Date.UTC(2000, 0, 1, 12);
const RAD = Math.PI / 180, DEG = 180 / Math.PI, TAU = Math.PI * 2;

// ---- Site registry ---------------------------------------------------------
// The model carries its own geography — without it, no shadow or daylight
// number can be trusted. tz is the site's standard-time UTC offset (hours).
export const SITES = {
  boston: { label: 'Boston, USA', lat: 42.3601, lon: -71.0589, tz: -5, desc: 'Cold winters, low winter sun, strict shadow law' },
  newyork: { label: 'New York, USA', lat: 40.7128, lon: -74.0060, tz: -5, desc: 'Dense grid, tall neighbours' },
  london: { label: 'London, UK', lat: 51.5072, lon: -0.1276, tz: 0, desc: 'Overcast sky, very low winter sun' },
  malmo: { label: 'Malmö, Sweden', lat: 55.6133, lon: 12.9756, tz: 1, desc: 'High latitude — long shadows, bright summers' },
  shanghai: { label: 'Shanghai, China', lat: 31.2304, lon: 121.4737, tz: 8, desc: 'Hot-humid summers, mild winters' },
  singapore: { label: 'Singapore', lat: 1.3521, lon: 103.8198, tz: 8, desc: 'Equatorial — sun overhead, shade is everything' },
  dubai: { label: 'Dubai, UAE', lat: 25.2048, lon: 55.2708, tz: 4, desc: 'Low-latitude sun, brutal cooling loads' },
};

let siteKey = localStorage.getItem('napkin_site') || 'boston';
if (!SITES[siteKey]) siteKey = 'boston';

// A searched address becomes a first-class site: same solar math, real place.
let customSite = null;
export function setCustomSite(lat, lon, label, tz) {
  customSite = { lat: +lat, lon: +lon, tz: Number.isFinite(+tz) ? +tz : Math.round(+lon / 15), label: label || 'Project site', desc: 'Your searched project location' };
  return getSite();
}
export function clearCustomSite() { customSite = null; }

export function getSite() {
  if (customSite) return { key: 'custom', ...customSite };
  return { key: siteKey, ...SITES[siteKey] };
}
export function setSite(key) {
  if (SITES[key]) { siteKey = key; customSite = null; localStorage.setItem('napkin_site', key); }
  return getSite();
}

// Season shortcuts map to real dates (solstices / equinox of the current year).
export function seasonDate(season) {
  const y = new Date().getFullYear();
  return { winter: `${y}-12-21`, equinox: `${y}-03-20`, summer: `${y}-06-21` }[season] || `${y}-03-20`;
}

// ---- NOAA solar position ---------------------------------------------------

function equationOfTime(t) {
  const e = eccentricity(t), m = meanAnomaly(t), l = meanLongitude(t);
  let y = Math.tan(obliquityCorrection(t) / 2);
  y *= y;
  return y * Math.sin(2 * l) - 2 * e * Math.sin(m)
    + 4 * e * y * Math.sin(m) * Math.cos(2 * l)
    - 0.5 * y * y * Math.sin(4 * l)
    - 1.25 * e * e * Math.sin(2 * m);
}
function declination(t) {
  return Math.asin(Math.sin(obliquityCorrection(t)) * Math.sin(apparentLongitude(t)));
}
function apparentLongitude(t) {
  return trueLongitude(t) - (0.00569 + 0.00478 * Math.sin((125.04 - 1934.136 * t) * RAD)) * RAD;
}
function trueLongitude(t) { return meanLongitude(t) + equationOfCenter(t); }
function meanAnomaly(t) { return (357.52911 + t * (35999.05029 - 0.0001537 * t)) * RAD; }
function meanLongitude(t) {
  const l = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  return (l < 0 ? l + 360 : l) * RAD;
}
function equationOfCenter(t) {
  const m = meanAnomaly(t);
  return (Math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t))
    + Math.sin(2 * m) * (0.019993 - 0.000101 * t)
    + Math.sin(3 * m) * 0.000289) * RAD;
}
function obliquityCorrection(t) {
  return meanObliquity(t) + 0.00256 * Math.cos((125.04 - 1934.136 * t) * RAD) * RAD;
}
function meanObliquity(t) {
  return (23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60) * RAD;
}
function eccentricity(t) { return 0.016708634 - t * (0.000042037 + 0.0000001267 * t); }

// Position of the sun for a UTC timestamp (ms) at lat/lon (degrees).
// Returns { alt, az } in radians — az is compass (0 = N, clockwise), with
// atmospheric refraction applied near the horizon.
export function solarPositionUTC(utcMs, latDeg, lonDeg) {
  const t = (utcMs - J2000) / (864e5 * 36525);
  const λ = lonDeg * RAD, φ = latDeg * RAD;
  const cosφ = Math.cos(φ), sinφ = Math.sin(φ);
  const θ = declination(t), cosθ = Math.cos(θ), sinθ = Math.sin(θ);
  const dayStart = utcMs - (((utcMs % 864e5) + 864e5) % 864e5);
  let az = ((utcMs - dayStart) / 864e5 * TAU + equationOfTime(t) + λ) % TAU - Math.PI;
  if (az < -Math.PI) az += TAU;
  let zen = Math.acos(Math.max(-1, Math.min(1, sinφ * sinθ + cosφ * cosθ * Math.cos(az))));
  const denom = cosφ * Math.sin(zen);
  if (Math.abs(denom) > 1e-6) {
    az = (az > 0 ? -1 : 1) * (Math.PI - Math.acos(Math.max(-1, Math.min(1, (sinφ * Math.cos(zen) - sinθ) / denom))));
  }
  if (az < 0) az += TAU;
  // Atmospheric refraction
  const el = 90 - zen * DEG;
  if (el <= 85) {
    const te = Math.tan(el * RAD);
    zen -= (el > 5 ? 58.1 / te - 0.07 / (te ** 3) + 0.000086 / (te ** 5)
      : el > -0.575 ? 1735 + el * (-518.2 + el * (103.4 + el * (-12.79 + el * 0.711)))
      : -20.774 / te) / 3600 * RAD;
  }
  return { alt: Math.PI / 2 - zen, az };
}

// Sun for a local date ('YYYY-MM-DD') + decimal local hour at the current site.
export function sunAt(dateStr, localHour, site = getSite()) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d) + (localHour - site.tz) * 3600e3;
  return solarPositionUTC(utc, site.lat, site.lon);
}

// Compass az/alt → world direction (unit vector) toward the sun.
export function sunDirection(alt, az) {
  return {
    x: Math.sin(az) * Math.cos(alt),
    y: Math.sin(alt),
    z: -Math.cos(az) * Math.cos(alt),
  };
}

// Horizontal shadow direction (unit, on ground) cast by the sun — opposite side.
export function shadowDirection(az) {
  return { x: -Math.sin(az), z: Math.cos(az) };
}

// Sunrise / sunset (decimal local hours) by scanning — robust at any latitude.
// Returns null at polar night / midnight sun.
export function daylightWindow(dateStr, site = getSite()) {
  let rise = null, set = null, prevUp = sunAt(dateStr, 0, site).alt > 0;
  for (let h = 0; h <= 24; h += 1 / 12) {
    const up = sunAt(dateStr, h, site).alt > 0;
    if (up && !prevUp && rise === null) rise = h;
    if (!up && prevUp) set = h;
    prevUp = up;
  }
  if (rise === null && set === null) return prevUp ? { rise: 0, set: 24 } : null;
  return { rise: rise ?? 0, set: set ?? 24 };
}

// Sample the sun's arc across a day — for drawing the sun path in 3D.
// Returns [{hour, alt, az}] for daylight hours only.
export function sunPath(dateStr, site = getSite(), stepH = 0.25) {
  const out = [];
  for (let h = 0; h <= 24; h += stepH) {
    const p = sunAt(dateStr, h, site);
    if (p.alt > -0.02) out.push({ hour: h, alt: p.alt, az: p.az });
  }
  return out;
}

// Winter-solstice noon altitude (radians) at the current site — metrics use
// this instead of a hard-coded Boston constant.
export function winterNoonAlt(site = getSite()) {
  const y = new Date().getFullYear();
  // scan around solar noon; local noon is close enough to find the max
  let best = 0;
  for (let h = 10; h <= 14; h += 0.25) {
    const { alt } = sunAt(`${y}-12-21`, h, site);
    if (alt > best) best = alt;
  }
  return Math.max(best, 2 * RAD);
}

export function fmtLatLon(site = getSite()) {
  const ns = site.lat >= 0 ? 'N' : 'S', ew = site.lon >= 0 ? 'E' : 'W';
  return `${Math.abs(site.lat).toFixed(4)}°${ns} ${Math.abs(site.lon).toFixed(4)}°${ew}`;
}
