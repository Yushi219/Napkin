// Measuring the likeness, in code.
//
// The correction passes used to be a model looking at its own render and
// deciding whether it had improved. The literature on that is blunt: without
// an external signal a model's self-correction degrades output about as often
// as it improves it, and vision models judging structured 3D reconstructions
// score at roughly chance. So the judgement moves here, into arithmetic that
// takes ~40 ms and never flatters anyone.
//
// Two numbers carry it, chosen because they are the two that agreed most with
// expert preference in the ICCV-2025 study of building-wireframe metrics:
// edge recall (0.83 agreement) and a Jaccard/IoU term (0.81). Recall is
// weighted above precision on that study's finding that people judge a
// reconstruction by what it got right, not by what it added.

const N = 256;

function toGrey(url) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = cv.height = N;
      const c = cv.getContext('2d', { willReadFrequently: true });
      c.fillStyle = '#fff';
      c.fillRect(0, 0, N, N);
      // contain, so reference and render share one frame of reference
      const s = Math.min(N / im.width, N / im.height);
      const w = im.width * s, h = im.height * s;
      c.drawImage(im, (N - w) / 2, (N - h) / 2, w, h);
      const d = c.getImageData(0, 0, N, N).data;
      const g = new Float32Array(N * N);
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        g[p] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
      }
      resolve(g);
    };
    im.onerror = reject;
    im.src = url;
  });
}

// Ink: anything meaningfully darker than the paper it sits on.
function inkMask(g, tol = 0.22) {
  const bg = (g[0] + g[N - 1] + g[N * N - N] + g[N * N - 1]) / 4;
  const m = new Uint8Array(N * N);
  for (let i = 0; i < g.length; i++) m[i] = bg - g[i] > tol ? 1 : 0;
  return m;
}

// A line drawing is an outline; the render is a filled body. Comparing them
// directly would punish the drawing for being hollow, so the drawing's
// silhouette is filled first: flood the background in from the border, and
// everything unreached is inside.
function fillOutline(mask) {
  const out = new Uint8Array(N * N).fill(1);
  const seen = new Uint8Array(N * N);
  const stack = [];
  for (let x = 0; x < N; x++) { stack.push(x, (N - 1) * N + x); }
  for (let y = 0; y < N; y++) { stack.push(y * N, y * N + N - 1); }
  while (stack.length) {
    const p = stack.pop();
    if (seen[p] || mask[p]) continue;
    seen[p] = 1; out[p] = 0;
    const x = p % N, y = (p - x) / N;
    if (x > 0) stack.push(p - 1);
    if (x < N - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - N);
    if (y < N - 1) stack.push(p + N);
  }
  return out;
}

// Sobel magnitude, thresholded — the render's edges, to compare against ink.
function edges(g, tol = 0.14) {
  const e = new Uint8Array(N * N);
  for (let y = 1; y < N - 1; y++) {
    for (let x = 1; x < N - 1; x++) {
      const i = y * N + x;
      const gx = -g[i - N - 1] - 2 * g[i - 1] - g[i + N - 1] + g[i - N + 1] + 2 * g[i + 1] + g[i + N + 1];
      const gy = -g[i - N - 1] - 2 * g[i - N] - g[i - N + 1] + g[i + N - 1] + 2 * g[i + N] + g[i + N + 1];
      e[i] = Math.hypot(gx, gy) > tol * 4 ? 1 : 0;
    }
  }
  return e;
}

// Dilate by the tolerance radius, so "within τ of an edge" is a lookup.
function dilate(mask, r) {
  let cur = mask;
  for (let pass = 0; pass < r; pass++) {
    const next = new Uint8Array(N * N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        if (cur[i]
          || (x > 0 && cur[i - 1]) || (x < N - 1 && cur[i + 1])
          || (y > 0 && cur[i - N]) || (y < N - 1 && cur[i + N])) next[i] = 1;
      }
    }
    cur = next;
  }
  return cur;
}

// The skyline: for each column, the topmost ink row. This step function IS the
// massing seen from this camera — each plateau a mass top, each riser a
// setback — and it localises error to a band of the image, which is what makes
// feedback actionable rather than vague.
function skyline(mask) {
  const top = new Float32Array(N).fill(NaN);
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) {
      if (mask[y * N + x]) { top[x] = 1 - y / N; break; }
    }
  }
  return top;
}

function extent(mask) {
  let minX = N, maxX = -1, minY = N, maxY = -1, n = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (!mask[y * N + x]) continue;
    n++;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return n ? { minX: minX / N, maxX: maxX / N, minY: minY / N, maxY: maxY / N, n } : null;
}

// ---------------- the score ----------------

export async function scoreAgainst(referenceURL, renderURL) {
  const [rg, sg] = await Promise.all([toGrey(referenceURL), toGrey(renderURL)]);
  const refInk = inkMask(rg);
  const refFill = fillOutline(refInk);
  const renInk = inkMask(sg);
  const renFill = fillOutline(renInk);
  const renEdge = edges(sg);

  let inter = 0, union = 0;
  for (let i = 0; i < refFill.length; i++) {
    const a = refFill[i], b = renFill[i];
    if (a || b) union++;
    if (a && b) inter++;
  }
  const iou = union ? inter / union : 0;

  const tau = 4;                                   // ≈1.5% of the diagonal
  const renderNear = dilate(renEdge, tau);
  const refNear = dilate(refInk, tau);
  let hit = 0, refN = 0, prec = 0, renN = 0;
  for (let i = 0; i < refInk.length; i++) {
    if (refInk[i]) { refN++; if (renderNear[i]) hit++; }
    if (renEdge[i]) { renN++; if (refNear[i]) prec++; }
  }
  const recall = refN ? hit / refN : 0;
  const precision = renN ? prec / renN : 0;
  const f1 = recall + precision ? (2 * recall * precision) / (recall + precision) : 0;

  return {
    // recall leads: people judge a reconstruction by what it got right
    score: 0.45 * recall + 0.35 * iou + 0.20 * f1,
    recall, precision, f1, iou,
    refSky: skyline(refInk), renSky: skyline(renInk),
    refBox: extent(refFill), renBox: extent(renFill),
  };
}

// ---------------- the measurement report ----------------
// Not a critique — a set of measurements the model cannot compute but can act
// on. Pairing numbers with the images is what turns a weak visual-comparison
// faculty into a strong instruction-following one.

export function measurementReport(m) {
  const L = [];
  L.push(`MEASURED (by code, from the two images — these are facts, not opinions):`);
  L.push(`- likeness score ${(m.score * 100).toFixed(0)}/100  (edge recall ${(m.recall * 100).toFixed(0)}%, silhouette overlap ${(m.iou * 100).toFixed(0)}%)`);

  if (m.refBox && m.renBox) {
    const rw = m.refBox.maxX - m.refBox.minX, sw = m.renBox.maxX - m.renBox.minX;
    const rh = m.refBox.maxY - m.refBox.minY, sh = m.renBox.maxY - m.renBox.minY;
    const dw = ((sw - rw) / rw) * 100, dh = ((sh - rh) / rh) * 100;
    if (Math.abs(dw) > 6) L.push(`- the model is ${Math.abs(dw).toFixed(0)}% too ${dw > 0 ? 'WIDE' : 'NARROW'} on screen`);
    if (Math.abs(dh) > 6) L.push(`- the model is ${Math.abs(dh).toFixed(0)}% too ${dh > 0 ? 'TALL' : 'SHORT'} on screen`);
    const dx = ((m.renBox.minX + m.renBox.maxX) / 2 - (m.refBox.minX + m.refBox.maxX) / 2) * 100;
    if (Math.abs(dx) > 5) L.push(`- the model sits ${Math.abs(dx).toFixed(0)}% of the frame too far ${dx > 0 ? 'RIGHT' : 'LEFT'}`);
  }

  // the skyline, in five bands, so an error has a place
  const bands = 5;
  const notes = [];
  for (let b = 0; b < bands; b++) {
    const x0 = Math.floor((b / bands) * N), x1 = Math.floor(((b + 1) / bands) * N);
    let rs = 0, ss = 0, n = 0;
    for (let x = x0; x < x1; x++) {
      if (!Number.isNaN(m.refSky[x]) && !Number.isNaN(m.renSky[x])) { rs += m.refSky[x]; ss += m.renSky[x]; n++; }
    }
    if (!n) continue;
    const diff = (ss / n) - (rs / n);
    if (Math.abs(diff) > 0.05) {
      notes.push(`  · band ${b + 1} of 5 (from the left): the model's top is ${(Math.abs(diff) * 100).toFixed(0)}% of the frame too ${diff > 0 ? 'HIGH' : 'LOW'}`);
    }
  }
  if (notes.length) {
    L.push(`- the skyline, compared column by column:`);
    L.push(...notes);
  } else {
    L.push(`- the skyline matches across the frame`);
  }
  L.push(`Correct what these numbers name. If a number is already close, leave that part alone.`);
  return L.join('\n');
}
