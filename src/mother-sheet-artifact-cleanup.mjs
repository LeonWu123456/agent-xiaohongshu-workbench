function finiteInteger(value, fallback = 0) {
  const number = Math.round(Number(value));
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function neutralRuleRatio(data, width, height, channels, axis, coordinate) {
  let matches = 0; let sampled = 0;
  const length = axis === "x" ? height : width;
  const step = Math.max(1, Math.floor(length / 240));
  for (let offset = 0; offset < length; offset += step) {
    const x = axis === "x" ? coordinate : offset;
    const y = axis === "x" ? offset : coordinate;
    const index = (y * width + x) * channels;
    const rgb = [data[index], data[index + 1], data[index + 2]];
    const lightness = (rgb[0] + rgb[1] + rgb[2]) / 3;
    const chroma = Math.max(...rgb) - Math.min(...rgb);
    sampled += 1;
    if (lightness >= 150 && lightness <= 242 && chroma <= 24) matches += 1;
  }
  return matches / Math.max(1, sampled);
}

function whitePixel(data, width, channels, x, y) {
  const index = (y * width + x) * channels;
  data[index] = 255; data[index + 1] = 255; data[index + 2] = 255;
  if (channels > 3) data[index + 3] = 255;
}

function edgeConnectedPaperPixel(data, width, channels, x, y) {
  const index = (y * width + x) * channels;
  if (channels > 3 && data[index + 3] < 250) return false;
  const red = data[index]; const green = data[index + 1]; const blue = data[index + 2];
  const lightness = (red + green + blue) / 3;
  const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
  // Seedream often returns a softly graded warm paper even when the prompt asks
  // for #FFFFFF. Connectivity keeps the operation on the outside paper; this
  // broader traversal threshold lets the later feather reach the full gradient
  // instead of cutting a jagged hard boundary through it.
  return lightness >= 185 && chroma <= 45;
}

function paperSubjectBoundaryDistances(visited, width, height, queue, radius = 3) {
  const distances = new Uint8Array(visited.length);
  let head = 0; let tail = 0;
  const inside = (x, y) => x >= 0 && x < width && y >= 0 && y < height;
  for (let offset = 0; offset < visited.length; offset += 1) {
    if (!visited[offset]) continue;
    const x = offset % width; const y = Math.floor(offset / width);
    let touchesSubject = false;
    for (let dy = -1; dy <= 1 && !touchesSubject; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if ((!dx && !dy) || !inside(x + dx, y + dy)) continue;
        if (!visited[(y + dy) * width + x + dx]) { touchesSubject = true; break; }
      }
    }
    if (!touchesSubject) continue;
    distances[offset] = 1;
    queue[tail] = offset;
    tail += 1;
  }
  while (head < tail) {
    const offset = queue[head]; head += 1;
    const distance = distances[offset];
    if (distance >= radius) continue;
    const x = offset % width; const y = Math.floor(offset / width);
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if ((!dx && !dy) || !inside(x + dx, y + dy)) continue;
        const next = (y + dy) * width + x + dx;
        if (!visited[next] || distances[next]) continue;
        distances[next] = distance + 1;
        queue[tail] = next;
        tail += 1;
      }
    }
  }
  return distances;
}

function paperBoundaryStrength(distance) {
  if (distance === 1) return .36;
  if (distance === 2) return .72;
  if (distance === 3) return .94;
  return 1;
}

function applyPaperStrength(data, channels, offset, strength) {
  const index = offset * channels;
  const red = data[index]; const green = data[index + 1]; const blue = data[index + 2];
  const next = [red, green, blue].map((value) => Math.round(value + (255 - value) * strength));
  const changed = next[0] !== red || next[1] !== green || next[2] !== blue;
  data[index] = next[0]; data[index + 1] = next[1]; data[index + 2] = next[2];
  if (channels > 3) data[index + 3] = 255;
  return changed;
}

function normalizeEdgeConnectedPaper(data, width, height, channels) {
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0; let tail = 0;
  const enqueue = (x, y) => {
    const offset = y * width + x;
    if (visited[offset] || !edgeConnectedPaperPixel(data, width, channels, x, y)) return;
    visited[offset] = 1;
    queue[tail] = offset;
    tail += 1;
  };
  for (let x = 0; x < width; x += 1) { enqueue(x, 0); enqueue(x, height - 1); }
  for (let y = 1; y < height - 1; y += 1) { enqueue(0, y); enqueue(width - 1, y); }
  while (head < tail) {
    const offset = queue[head]; head += 1;
    const x = offset % width; const y = Math.floor(offset / width);
    if (x > 0) enqueue(x - 1, y);
    if (x + 1 < width) enqueue(x + 1, y);
    if (y > 0) enqueue(x, y - 1);
    if (y + 1 < height) enqueue(x, y + 1);
  }
  const boundaryDistances = paperSubjectBoundaryDistances(visited, width, height, queue, 3);
  let changed = 0;
  for (let offset = 0; offset < visited.length; offset += 1) {
    if (!visited[offset]) continue;
    // Flood-fill owns paper membership. Every connected interior pixel becomes
    // exact white; only the three pixels nearest a non-paper subject use a
    // fixed-distance feather. Original paper lightness never weakens the core
    // cleanup, while dark outlines keep enclosed skin, clothes and props out.
    if (applyPaperStrength(data, channels, offset, paperBoundaryStrength(boundaryDistances[offset]))) changed += 1;
  }
  return changed;
}

function findRule(data, width, height, channels, axis, start, end) {
  let best = null;
  for (let coordinate = start; coordinate <= end; coordinate += 1) {
    const ratio = neutralRuleRatio(data, width, height, channels, axis, coordinate);
    if (ratio >= .68 && (!best || ratio > best.ratio)) best = { coordinate, ratio };
  }
  return best;
}

export function cleanupGeneratedGridArtifacts(image, { kv = false, paperOnly = false, enforceWhitePaper = false, previousActions = [] } = {}) {
  const source = image?.data;
  const width = finiteInteger(image?.width);
  const height = finiteInteger(image?.height);
  const channels = finiteInteger(image?.channels, 4);
  if (!(source instanceof Uint8Array) || !width || !height || ![3, 4].includes(channels) || source.length < width * height * channels) throw new TypeError("mother-sheet cleanup pixels are invalid");
  const data = new Uint8Array(source);
  const actions = [];
  // Assets repaired by the v3 routine already have the rule itself painted
  // white, but can still retain a neighbour-cell strip outside that rule.
  // Replay the recorded coordinate as an edge-band cleanup so old paid assets
  // can be repaired without regenerating or recharging.
  for (const prior of paperOnly ? [] : (Array.isArray(previousActions) ? previousActions : [])) {
    if (prior?.type !== "HORIZONTAL_GRID_RULE_REMOVED") continue;
    const coordinate = Math.max(0, Math.min(height - 1, Math.round(Number(prior.coordinate))));
    const edge = coordinate < height / 2 ? "top" : "bottom";
    const from = edge === "top" ? 0 : Math.max(0, coordinate - 3);
    const to = edge === "top" ? Math.min(height - 1, coordinate + 3) : height - 1;
    for (let y = from; y <= to; y += 1) for (let x = 0; x < width; x += 1) whitePixel(data, width, channels, x, y);
    actions.push({ type: "LEGACY_HORIZONTAL_GRID_EDGE_BAND_REMOVED", edge, coordinate, from, to });
  }
  if (!paperOnly && kv) {
    const seam = findRule(data, width, height, channels, "x", Math.round(width * .08), Math.round(width * .4));
    if (seam) {
      for (let y = 0; y < height; y += 1) for (let x = 0; x <= Math.min(width - 1, seam.coordinate + 3); x += 1) whitePixel(data, width, channels, x, y);
      actions.push({ type: "KV_LEFT_CONTAMINATION_REMOVED", coordinate: seam.coordinate, ratio: seam.ratio });
    }
  }
  const horizontalRanges = [
    { edge: "top", start: 0, end: Math.round(height * .08) },
    { edge: "bottom", start: Math.round(height * .92), end: height - 1 },
  ];
  if (!paperOnly) horizontalRanges.forEach(({ edge, start, end }) => {
    const rule = findRule(data, width, height, channels, "y", start, end);
    if (!rule) return;
    // The leaked material sits between the tile edge and the detected grid
    // rule. Whitening only the rule itself preserves a strip of the neighbour
    // cell (the exact failure seen in the paid dogfood run), so clean the
    // complete contaminated edge band.
    const from = edge === "top" ? 0 : Math.max(0, rule.coordinate - 3);
    const to = edge === "top" ? Math.min(height - 1, rule.coordinate + 3) : height - 1;
    for (let y = from; y <= to; y += 1) {
      for (let x = 0; x < width; x += 1) whitePixel(data, width, channels, x, y);
    }
    actions.push({ type: "HORIZONTAL_GRID_EDGE_BAND_REMOVED", edge, coordinate: rule.coordinate, ratio: rule.ratio, from, to });
  });
  const verticalRanges = [
    { edge: "left", start: 0, end: Math.round(width * .08) },
    { edge: "right", start: Math.round(width * .92), end: width - 1 },
  ];
  if (!paperOnly) verticalRanges.forEach(({ edge, start, end }) => {
    const rule = findRule(data, width, height, channels, "x", start, end);
    if (!rule) return;
    const from = edge === "left" ? 0 : Math.max(0, rule.coordinate - 3);
    const to = edge === "left" ? Math.min(width - 1, rule.coordinate + 3) : width - 1;
    for (let x = from; x <= to; x += 1) {
      for (let y = 0; y < height; y += 1) whitePixel(data, width, channels, x, y);
    }
    actions.push({ type: "VERTICAL_GRID_EDGE_BAND_REMOVED", edge, coordinate: rule.coordinate, ratio: rule.ratio, from, to });
  });
  const normalizedPaperPixels = normalizeEdgeConnectedPaper(data, width, height, channels);
  if (normalizedPaperPixels > 0) actions.push({ type: "EDGE_CONNECTED_PAPER_NORMALIZED", pixels: normalizedPaperPixels });
  return { data, width, height, channels, actions };
}
