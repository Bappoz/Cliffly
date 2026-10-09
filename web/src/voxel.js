export const MAX_BLOCKS = 19200;
export const PALETTE = [
  [103, 151, 69],
  [71, 108, 51],
  [132, 99, 68],
  [186, 150, 100],
  [132, 136, 137],
  [205, 206, 200],
  [229, 219, 177],
  [77, 137, 184],
  [185, 89, 65],
  [235, 192, 77],
  [239, 237, 225],
  [44, 46, 49],
];

export function nearestColor(r, g, b) {
  let best = PALETTE[0],
    distance = Infinity;
  for (const color of PALETTE) {
    const d = (r - color[0]) ** 2 + (g - color[1]) ** 2 + (b - color[2]) ** 2;
    if (d < distance) {
      distance = d;
      best = color;
    }
  }
  return best;
}

// Depth values are relative inverse depth: 1 = nearer, 0 = farther.
// Brightness never supplies depth. Pinhole projection preserves pixel positions.
export function buildScene({
  rgba,
  width,
  height,
  depth = null,
  depthMode = "plane",
  fov = 55,
  depthStrength = 1,
  palette = "original",
  smoothing = 0.3,
  previous = null,
}) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > MAX_BLOCKS
  )
    throw new Error("Resolução fora do limite de 19.200 blocos.");
  if (rgba.length !== width * height * 4)
    throw new Error("Frame RGB incompleto.");
  if (depth && depth.length !== width * height)
    throw new Error("Mapa de profundidade incompatível.");
  if (!Number.isFinite(fov) || fov < 25 || fov > 100)
    throw new Error("Campo de visão inválido.");
  if (!Number.isFinite(depthStrength) || depthStrength < 0 || depthStrength > 2)
    throw new Error("Intensidade inválida.");
  if (!Number.isFinite(smoothing) || smoothing < 0 || smoothing > 0.9)
    throw new Error("Suavização inválida.");
  const focal = height / (2 * Math.tan((fov * Math.PI) / 360));
  const points = new Float32Array(width * height * 7);
  const compatible =
    previous?.width === width &&
    previous?.height === height &&
    previous?.depthMode === depthMode &&
    previous?.fov === fov &&
    previous?.palette === palette;
  for (let i = 0; i < width * height; i++) {
    const offset = i * 7,
      pixel = i * 4;
    const near =
      depth && Number.isFinite(depth[i])
        ? Math.max(0, Math.min(1, depth[i]))
        : 0.5;
    let distance = depth ? 12 + (0.5 - near) * 10 * depthStrength : 12;
    let r = rgba[pixel],
      g = rgba[pixel + 1],
      b = rgba[pixel + 2];
    if (palette === "blocks") [r, g, b] = nearestColor(r, g, b);
    if (compatible) {
      const p = previous.points;
      // Large changes are movement, not noise: avoid blending old object edges.
      const colorChange =
        Math.abs(r - p[offset + 4]) +
        Math.abs(g - p[offset + 5]) +
        Math.abs(b - p[offset + 6]);
      if (colorChange < 70 && Math.abs(distance + p[offset + 2]) < 0.7) {
        distance = distance * (1 - smoothing) - p[offset + 2] * smoothing;
        if (palette === "original") {
          r = r * (1 - smoothing) + p[offset + 4] * smoothing;
          g = g * (1 - smoothing) + p[offset + 5] * smoothing;
          b = b * (1 - smoothing) + p[offset + 6] * smoothing;
        }
      }
    }
    points[offset] = (((i % width) + 0.5 - width / 2) * distance) / focal;
    points[offset + 1] =
      (-(Math.floor(i / width) + 0.5 - height / 2) * distance) / focal;
    points[offset + 2] = -distance;
    points[offset + 3] = (distance / focal) * 0.97;
    points[offset + 4] = r;
    points[offset + 5] = g;
    points[offset + 6] = b;
  }
  return {
    version: 1,
    width,
    height,
    fov,
    depthMode: depth ? depthMode : "plane",
    palette,
    points,
  };
}

export function serializeScene(scene) {
  return JSON.stringify({
    ...scene,
    createdAt: new Date().toISOString(),
    points: Array.from(scene.points),
  });
}

export function parseScene(text) {
  if (typeof text !== "string" || text.length > 12_000_000)
    throw new Error("Arquivo muito grande. Limite: 12 MB.");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("O arquivo não é um JSON válido.");
  }
  if (
    value?.version !== 1 ||
    !Number.isInteger(value.width) ||
    !Number.isInteger(value.height) ||
    value.width < 1 ||
    value.height < 1 ||
    value.width * value.height > MAX_BLOCKS ||
    !Number.isFinite(value.fov) ||
    value.fov < 25 ||
    value.fov > 100 ||
    !["plane", "demo", "estimated"].includes(value.depthMode) ||
    !["original", "blocks"].includes(value.palette) ||
    !Array.isArray(value.points) ||
    value.points.length !== value.width * value.height * 7
  )
    throw new Error("Snapshot Cliffly incompatível ou incompleto.");
  for (let i = 0; i < value.points.length; i++) {
    const n = value.points[i],
      component = i % 7;
    if (
      !Number.isFinite(n) ||
      (component < 3 && Math.abs(n) > 10000) ||
      (component === 3 && (n <= 0 || n > 100)) ||
      (component > 3 && (n < 0 || n > 255))
    )
      throw new Error("O snapshot contém posições ou cores inválidas.");
  }
  return {
    version: 1,
    width: value.width,
    height: value.height,
    fov: value.fov,
    depthMode: value.depthMode,
    palette: value.palette,
    points: new Float32Array(value.points),
  };
}

export function exportPly(scene) {
  const lines = [
    "ply",
    "format ascii 1.0",
    "comment Cliffly: relative units, observed surface only",
    `element vertex ${scene.points.length / 7}`,
    "property float x",
    "property float y",
    "property float z",
    "property uchar red",
    "property uchar green",
    "property uchar blue",
    "property float block_size",
    "end_header",
  ];
  for (let i = 0; i < scene.points.length; i += 7) {
    const p = scene.points;
    lines.push(
      `${p[i].toFixed(5)} ${p[i + 1].toFixed(5)} ${p[i + 2].toFixed(5)} ${Math.round(p[i + 4])} ${Math.round(p[i + 5])} ${Math.round(p[i + 6])} ${p[i + 3].toFixed(5)}`,
    );
  }
  return lines.join("\n") + "\n";
}

export function sampleDepth(
  data,
  width,
  height,
  targetWidth,
  targetHeight,
  channels = 1,
) {
  const result = new Float32Array(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y++) {
    const sourceY = Math.min(
      height - 1,
      Math.floor(((y + 0.5) * height) / targetHeight),
    );
    for (let x = 0; x < targetWidth; x++) {
      const sourceX = Math.min(
        width - 1,
        Math.floor(((x + 0.5) * width) / targetWidth),
      );
      result[y * targetWidth + x] =
        data[(sourceY * width + sourceX) * channels] / 255;
    }
  }
  return result;
}
