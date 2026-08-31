function finiteInteger(value, fallback = 0) {
  const number = Math.round(Number(value));
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function neutralRuleRatio(data, width, channels, axis, coordinate, start, end) {
  let matches = 0; let sampled = 0;
  const length = Math.max(0, end - start);
  const step = Math.max(1, Math.floor(length / 320));
  for (let offset = start; offset < end; offset += step) {
    const x = axis === "x" ? coordinate : offset;
    const y = axis === "x" ? offset : coordinate;
    const index = (y * width + x) * channels;
    const rgb = [data[index], data[index + 1], data[index + 2]];
    const lightness = (rgb[0] + rgb[1] + rgb[2]) / 3;
    const chroma = Math.max(...rgb) - Math.min(...rgb);
    sampled += 1;
    if (lightness >= 150 && lightness <= 245 && chroma <= 28) matches += 1;
  }
  return matches / Math.max(1, sampled);
}

function strongestRule(data, width, channels, axis, from, to, spanStart, spanEnd, threshold = .55) {
  let best = null;
  for (let coordinate = from; coordinate <= to; coordinate += 1) {
    const ratio = neutralRuleRatio(data, width, channels, axis, coordinate, spanStart, spanEnd);
    if (ratio >= threshold && (!best || ratio > best.ratio)) best = { coordinate, ratio };
  }
  return best;
}

function rowDifference(data, width, height, channels, firstY, secondY) {
  const y1 = Math.max(0, Math.min(height - 1, firstY));
  const y2 = Math.max(0, Math.min(height - 1, secondY));
  let sampled = 0; let distance = 0;
  const step = Math.max(1, Math.floor(width / 240));
  for (let x = 0; x < width; x += step) {
    const first = (y1 * width + x) * channels;
    const second = (y2 * width + x) * channels;
    distance += Math.abs(data[first] - data[second])
      + Math.abs(data[first + 1] - data[second + 1])
      + Math.abs(data[first + 2] - data[second + 2]);
    sampled += 1;
  }
  return distance / Math.max(1, sampled * 3);
}

function paleRowRatio(data, width, channels, y) {
  let sampled = 0; let pale = 0;
  const step = Math.max(1, Math.floor(width / 320));
  for (let x = 0; x < width; x += step) {
    const index = (y * width + x) * channels;
    const lightness = (data[index] + data[index + 1] + data[index + 2]) / 3;
    const chroma = Math.max(data[index], data[index + 1], data[index + 2]) - Math.min(data[index], data[index + 1], data[index + 2]);
    sampled += 1;
    if (lightness >= 225 && chroma <= 38) pale += 1;
  }
  return pale / Math.max(1, sampled);
}

/**
 * Locate the real boundary between the continuous cover KV and the A/B/C row.
 * Image models routinely compress the KV to 52-62% of the mother sheet even
 * when the prompt asks for an exact two-thirds split. Fixed thirds therefore
 * leak A/B/C into the cover and amputate the tops of the illustrations.
 */
export function detectKvTemplateRegions(image) {
  const data = image?.data;
  const width = finiteInteger(image?.width);
  const height = finiteInteger(image?.height);
  const channels = finiteInteger(image?.channels, 4);
  if (!(data instanceof Uint8Array) || !width || !height || ![3, 4].includes(channels) || data.length < width * height * channels) throw new TypeError("mother-sheet adaptive pixels are invalid");
  const from = Math.round(height * .48);
  const to = Math.round(height * .73);
  const probe = Math.max(3, Math.round(height * .006));
  let best = null;
  for (let y = from; y <= to; y += 1) {
    const pale = paleRowRatio(data, width, channels, y);
    const transition = rowDifference(data, width, height, channels, y - probe, y + probe);
    const expectedPenalty = Math.abs((y / height) - (2 / 3)) * 18;
    const score = pale * 44 + Math.min(48, transition * 1.45) - expectedPenalty;
    if ((pale >= .68 || transition >= 19) && (!best || score > best.score)) best = { coordinate: y, pale_ratio: pale, transition, score };
  }
  if (!best || best.score < 30) return null;
  const gutter = Math.max(3, Math.round(Math.min(width, height) * .006));
  const kvBottom = Math.max(1, best.coordinate - gutter);
  const rowTop = Math.min(height - 2, best.coordinate + gutter);
  const cellWidth = Math.floor(width / 3);
  const cellHeight = Math.min(height - rowTop, Math.floor(cellWidth * 4 / 3));
  if (cellHeight < height * .25) return null;
  const insetX = Math.max(2, Math.round(cellWidth * .006));
  const illustrationRegions = Array.from({ length: 3 }, (_, index) => ({
    left: index * cellWidth + insetX,
    top: rowTop,
    width: cellWidth - insetX * 2,
    height: cellHeight,
  }));
  return {
    boundary: best,
    gutter,
    regions: [
      { left: 0, top: 0, width, height: kvBottom },
      ...illustrationRegions,
    ],
  };
}

/**
 * Detect the real A/B left-column cells in a KV 2x2 mother sheet. Generative
 * models sometimes widen that column instead of respecting an equal 3x3 grid;
 * fixed thirds then amputate the action on the right. The detector follows the
 * actual neutral divider rules and fails back to null when evidence is weak.
 */
export function detectKvTemplateLeftColumnRegions(image) {
  const data = image?.data;
  const width = finiteInteger(image?.width);
  const height = finiteInteger(image?.height);
  const channels = finiteInteger(image?.channels, 4);
  if (!(data instanceof Uint8Array) || !width || !height || ![3, 4].includes(channels) || data.length < width * height * channels) throw new TypeError("mother-sheet adaptive pixels are invalid");
  const dividerX = strongestRule(
    data, width, channels, "x",
    Math.round(width * .3), Math.round(width * .58),
    0, Math.round(height * .67), .52,
  );
  if (!dividerX) return null;
  const firstY = strongestRule(
    data, width, channels, "y",
    Math.round(height * .2), Math.round(height * .45),
    0, dividerX.coordinate, .52,
  );
  const secondY = strongestRule(
    data, width, channels, "y",
    Math.round(height * .45), Math.round(height * .75),
    0, dividerX.coordinate, .52,
  );
  if (!firstY || !secondY || secondY.coordinate <= firstY.coordinate + 16) return null;
  // Leave enough room for the anti-aliased shadow around a generated divider;
  // a 2–3px inset only removed the mathematical line while its soft grey echo
  // remained visible after 1080px normalization.
  const inset = Math.max(3, Math.round(Math.min(width, height) * .012));
  const right = Math.max(inset + 1, dividerX.coordinate - inset);
  const firstBottom = Math.max(inset + 1, firstY.coordinate - inset);
  const secondTop = Math.min(height - 2, firstY.coordinate + inset);
  const secondBottom = Math.max(secondTop + 1, secondY.coordinate - inset);
  return {
    divider_x: dividerX,
    row_dividers: [firstY, secondY],
    regions: [
      { left: inset, top: inset, width: right - inset, height: firstBottom - inset },
      { left: inset, top: secondTop, width: right - inset, height: secondBottom - secondTop },
    ],
  };
}
