import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateWorld,
  worldPly,
  MAX_WORLD_BLOCKS,
} from "../src/world-file.js";

const world = () => ({
  version: 2,
  kind: "voxel-world",
  voxelSize: 1,
  points: [0, 0, 0, 1, 255, 100, 0],
  cameras: [{ position: [0, 0, 2], target: [0, 0, 0] }],
});
test("saved reconstructed world validates and exports points", () => {
  assert.equal(validateWorld(world()).points.length, 7);
  assert.match(worldPly(world()), /element vertex 1/);
  assert.match(worldPly(world()), /0 0 0 255 100 0/);
});
test("a single frame scene cannot masquerade as a reconstructed world", () => {
  assert.throws(() => validateWorld({ ...world(), version: 1 }), /versão 2/);
});
test("rejects nonfinite coordinates, colors, grid sizes and camera poses", () => {
  for (const index of [0, 4]) {
    const w = world();
    w.points[index] = NaN;
    assert.throws(() => validateWorld(w));
  }
  const badColor = world();
  badColor.points[4] = 256;
  assert.throws(() => validateWorld(badColor));
  const badSize = world();
  badSize.points[3] = 2;
  assert.throws(() => validateWorld(badSize));
  const badCamera = world();
  badCamera.cameras[0].position = [Infinity, 0, 0];
  assert.throws(() => validateWorld(badCamera));
});
test("enforces block budget", () => {
  const w = world();
  w.points = new Array((MAX_WORLD_BLOCKS + 1) * 7).fill(0);
  assert.throws(() => validateWorld(w), /120 mil/);
});
test("preview coverage has one finite value per reconstructed voxel", () => {
  assert.equal(
    validateWorld({ ...world(), preview: true, confidence: [0.4] })
      .confidence[0],
    0.4,
  );
  assert.throws(
    () => validateWorld({ ...world(), confidence: [] }),
    /Cobertura/,
  );
  assert.throws(
    () => validateWorld({ ...world(), confidence: [2] }),
    /Cobertura/,
  );
  assert.throws(
    () => validateWorld({ ...world(), confidence: [NaN] }),
    /Cobertura/,
  );
});
