export const MAX_WORLD_BLOCKS = 120000;

export function validateWorld(value) {
  if (value?.version !== 2 || value.kind !== "voxel-world")
    throw new Error("Escolha um mundo 3D do Cliffly (formato versão 2).");
  const points = value.points;
  if (
    !Array.isArray(points) ||
    !points.length ||
    points.length % 7 ||
    points.length > MAX_WORLD_BLOCKS * 7
  )
    throw new Error(
      "Quantidade de blocos inválida ou acima do limite de 120 mil.",
    );
  if (
    !Number.isFinite(value.voxelSize) ||
    value.voxelSize < 0.00001 ||
    value.voxelSize > 10000
  )
    throw new Error("Tamanho de bloco inválido.");
  for (let i = 0; i < points.length; i += 7) {
    for (let c = 0; c < 7; c++) {
      const number = points[i + c];
      if (!Number.isFinite(number) || Math.abs(number) > 100000)
        throw new Error("O mundo contém coordenadas inválidas.");
    }
    if (Math.abs(points[i + 3] - value.voxelSize) > 0.00002)
      throw new Error("Os blocos precisam pertencer à mesma grade.");
    for (let c = 4; c < 7; c++)
      if (points[i + c] < 0 || points[i + c] > 255)
        throw new Error("O mundo contém cores inválidas.");
  }
  if (!Array.isArray(value.cameras) || value.cameras.length > 120)
    throw new Error("Trajetória de câmera inválida.");
  for (const camera of value.cameras)
    for (const vector of [camera.position, camera.target])
      if (
        !Array.isArray(vector) ||
        vector.length !== 3 ||
        !vector.every((x) => Number.isFinite(x) && Math.abs(x) < 100000)
      )
        throw new Error("Posição de câmera inválida.");
  if (
    value.confidence !== undefined &&
    (!Array.isArray(value.confidence) ||
      value.confidence.length !== points.length / 7 ||
      !value.confidence.every((x) => Number.isFinite(x) && x >= 0 && x <= 1))
  )
    throw new Error("Cobertura do mundo inválida.");
  return value;
}

export function worldPly(world) {
  const lines = [
    "ply",
    "format ascii 1.0",
    `element vertex ${world.points.length / 7}`,
    "property float x",
    "property float y",
    "property float z",
    "property uchar red",
    "property uchar green",
    "property uchar blue",
    "end_header",
  ];
  for (let i = 0; i < world.points.length; i += 7)
    lines.push([0, 1, 2, 4, 5, 6].map((j) => world.points[i + j]).join(" "));
  return lines.join("\n") + "\n";
}
