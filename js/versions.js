// The version stream — every Build/Update/chat edit becomes a commit with the
// napkin thumbnail, the full parameter state and the metric brief. Speaks the
// same shape a Speckle adapter would push, so "connect Speckle" is a transport
// swap, not a redesign.

export const stream = { name: 'napkin-stream', commits: [] };
let idc = 1;

export function commit({ label, thumb, params, strokes, brief }) {
  stream.commits.push({
    id: 'c' + idc++,
    label: label || `v${stream.commits.length + 1}`,
    at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    thumb, params, strokes, brief,
  });
  if (stream.commits.length > 40) stream.commits.shift();
  return stream.commits[stream.commits.length - 1];
}

export function exportStream(finalParams) {
  const payload = {
    app: 'NAPKIN',
    exported: new Date().toISOString(),
    note: 'Sketch-to-building version stream. Speckle-ready: each commit carries full parameter state.',
    finalParams,
    commits: stream.commits.map(({ strokes, ...c }) => c),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `napkin-stream-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Sponsor adapters — v1 runs a local twin of each role and says so honestly.
export const SPONSORS = [
  {
    id: 'shapediver', name: 'ShapeDiver', role: 'cloud parametric reconstruction',
    local: 'local replay engine (same op semantics)',
    field: 'napkin_sd_ticket', placeholder: 'ShapeDiver ticket…',
  },
  {
    id: 'viktor', name: 'VIKTOR', role: 'structural pre-check panel',
    local: 'local slenderness/drift proxy',
    field: 'napkin_viktor_url', placeholder: 'VIKTOR app endpoint…',
  },
  {
    id: 'speckle', name: 'Speckle', role: 'version stream & handoff',
    local: 'local stream + JSON export',
    field: 'napkin_speckle', placeholder: 'server url + token…',
  },
];
export function sponsorStatus(s) {
  return localStorage.getItem(s.field) ? 'configured (adapter stub)' : s.local;
}
