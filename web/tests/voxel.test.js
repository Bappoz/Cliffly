import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildScene,
  serializeScene,
  parseScene,
  exportPly,
  sampleDepth,
  nearestColor,
} from "../src/voxel.js";
const frame = {
  width: 2,
  height: 2,
  rgba: new Uint8ClampedArray([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
  ]),
};

test("preserves RGB and image orientation, without brightness depth", () => {
  const scene = buildScene(frame),
    p = scene.points;
  assert.deepEqual(Array.from(p.slice(4, 7)), [255, 0, 0]);
  assert.ok(p[0] < 0 && p[1] > 0);
  assert.ok(p[7] > 0 && p[8] > 0);
  assert.ok(p[14] < 0 && p[15] < 0);
  assert.equal(p[2], p[23]);
  assert.equal(scene.depthMode, "plane");
});
test("pinhole projection matches original pixels for different distances", () => {
  const s = buildScene({
    ...frame,
    depth: new Float32Array([1, 0, 0.75, 0.5]),
    depthMode: "estimated",
  });
  const focal = 2 / (2 * Math.tan((55 * Math.PI) / 360));
  for (let i = 0; i < 4; i++) {
    assert.ok(
      Math.abs(
        (s.points[i * 7] / -s.points[i * 7 + 2]) * focal + 1 - ((i % 2) + 0.5),
      ) < 1e-6,
    );
  }
  assert.ok(s.points[2] > s.points[9]);
});
test("invalid and missing depth cannot produce NaN", () => {
  const s = buildScene({
    ...frame,
    depth: new Float32Array([NaN, Infinity, -100, 100]),
    depthMode: "estimated",
  });
  assert.ok(s.points.every(Number.isFinite));
});
test("smooths small noise but immediately follows large color changes", () => {
  const first = buildScene({ width: 1, height: 1, rgba: [100, 100, 100, 255] });
  const noise = buildScene({
    width: 1,
    height: 1,
    rgba: [110, 110, 110, 255],
    previous: first,
    smoothing: 0.5,
  });
  assert.equal(noise.points[4], 105);
  const moved = buildScene({
    width: 1,
    height: 1,
    rgba: [255, 0, 0, 255],
    previous: first,
  });
  assert.equal(moved.points[4], 255);
});
test("JSON round trip preserves every position, size and color", () => {
  const s = buildScene(frame);
  assert.deepEqual(parseScene(serializeScene(s)), s);
});
test("rejects oversized and malformed snapshots and nonfinite geometry", () => {
  assert.throws(() => buildScene({ ...frame, width: 20000 }));
  assert.throws(() => buildScene({ ...frame, rgba: [] }));
  assert.throws(() => buildScene({ ...frame, fov: NaN }));
  assert.throws(() => parseScene('{"version":9}'));
  assert.throws(() => parseScene("bad json"));
  const s = JSON.parse(serializeScene(buildScene(frame)));
  s.points[3] = -1;
  assert.throws(() => parseScene(JSON.stringify(s)));
  s.points[3] = 1;
  s.points[4] = 256;
  assert.throws(() => parseScene(JSON.stringify(s)));
});
test("PLY has valid vertex count and original byte colors", () => {
  const ply = exportPly(buildScene(frame));
  assert.ok(ply.includes("element vertex 4"));
  const vertices = ply.split("end_header\n")[1].trim().split("\n");
  assert.equal(vertices.length, 4);
  assert.deepEqual(vertices[0].split(" ").slice(3, 6), ["255", "0", "0"]);
});
test("depth resizing selects pixel centers and preserves orientation", () => {
  assert.deepEqual(
    Array.from(sampleDepth([0, 255, 255, 0], 2, 2, 2, 2)),
    [0, 1, 1, 0],
  );
  assert.deepEqual(Array.from(sampleDepth([0, 0, 0, 255], 2, 2, 1, 1)), [1]);
});
test("material palette maps an exact palette color without shifting it", () => {
  assert.deepEqual(nearestColor(103, 151, 69), [103, 151, 69]);
  const s = buildScene({ ...frame, palette: "blocks" });
  assert.ok(s.points[4] <= 255);
});
