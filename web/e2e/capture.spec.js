import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

const id = "12345678-1234-1234-1234-123456789abc";
const fixture = {
  version: 2,
  kind: "voxel-world",
  voxelSize: 1,
  points: [
    0, 0, -5, 1, 170, 90, 40, 1, 0, -5, 1, 40, 150, 70, 0, 1, -5, 1, 90, 120,
    170,
  ],
  cameras: [{ position: [0, 0, 0], target: [0, 0, -5] }],
  metrics: { registeredFrames: 3 },
  warnings: ["Escala relativa."],
};
const video = {
  name: "capture.webm",
  mimeType: "video/webm",
  buffer: Buffer.from("fake fixture; API routes mocked"),
};

test("home explains offline reconstruction without activating the camera", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("h1")).toContainText("Filme um lugar.");
  await expect(page.locator("#generate")).toBeDisabled();
  await expect(page.locator("#world-count")).toHaveText("0 BLOCOS");
  expect(
    await page.locator("#capture-video").evaluate((v) => v.srcObject),
  ).toBeNull();
  await page.locator("#help-open").click();
  await expect(page.locator("#help")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#help")).toBeHidden();
  await page.screenshot({ path: "/tmp/cliffly-home.png", fullPage: true });
});

test("recording stops, saves a playable blob and releases camera without uploading", async ({
  page,
}) => {
  const uploads = [];
  page.on("request", (r) => {
    if (r.url().includes("/sessions")) uploads.push(r.url());
  });
  await page.goto("/");
  await page.locator("#record").click();
  await expect(page.locator("#stop")).toBeVisible();
  await page.evaluate(() => {
    window.tracks = document
      .getElementById("capture-video")
      .srcObject.getTracks();
  });
  await page.waitForTimeout(1300);
  await page.locator("#stop").click();
  await expect(page.locator("#generate")).toBeEnabled();
  expect(
    await page.evaluate(() =>
      window.tracks.every((t) => t.readyState === "ended"),
    ),
  ).toBe(true);
  expect(
    await page.locator("#capture-video").evaluate((v) => v.srcObject),
  ).toBeNull();
  const saved = page.waitForEvent("download");
  await page.locator("#save-video").click();
  expect((await readFile(await (await saved).path())).length).toBeGreaterThan(
    1000,
  );
  expect(uploads).toEqual([]);
});

test("camera denial gives an import option", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Denied", "NotAllowedError");
    };
  });
  await page.goto("/");
  await page.locator("#record").click();
  await expect(page.locator("#status")).toContainText(
    "Permissão da câmera negada",
  );
  await expect(page.locator("#record")).toBeEnabled();
});

test("saved world is navigable, exportable and reopens without a video", async ({
  page,
}) => {
  test.setTimeout(90000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.locator("#example").click();
  await expect(page.locator("#world-title")).toHaveText(
    "Exemplo · sala sintética",
  );
  await expect(page.locator("#world-count")).not.toHaveText("0 BLOCOS");
  await page.locator("#free").click();
  const before = await page.locator("#world-canvas").screenshot();
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(700);
  await page.keyboard.up("KeyW");
  const after = await page.locator("#world-canvas").screenshot();
  expect(after.equals(before)).toBe(false);
  await page.keyboard.press("Home");
  await page.locator("#path").check();
  const saved = page.waitForEvent("download");
  await page.locator("#export-world").click();
  const file = await readFile(await (await saved).path());
  expect(JSON.parse(file).version).toBe(2);
  await page.locator("#world-file").setInputFiles({
    name: "world.json",
    mimeType: "application/json",
    buffer: file,
  });
  await expect(page.locator("#world-title")).toHaveText("Mundo salvo");
  const ply = page.waitForEvent("download");
  await page.locator("#export-ply").click();
  expect(await readFile(await (await ply).path(), "utf8")).toContain(
    "format ascii 1.0",
  );
  expect(errors).toEqual([]);
  await page.screenshot({ path: "/tmp/cliffly-world.png", fullPage: true });
});

test("invalid world and old frame snapshots are rejected", async ({ page }) => {
  await page.goto("/");
  await page.locator("#world-file").setInputFiles({
    name: "old.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ ...fixture, version: 1 })),
  });
  await expect(page.locator("#status")).toContainText("versão 2");
  await page.locator("#world-file").setInputFiles({
    name: "bad.json",
    mimeType: "application/json",
    buffer: Buffer.from("{"),
  });
  await expect(page.locator("#status")).toContainText("JSON válido");
});

test("upload, frames, reconstruction, progress and reload follow saved session", async ({
  page,
}) => {
  let scheduled = false,
    reads = 0,
    uploads = 0;
  await page.route("**/health", (r) =>
    r.fulfill({ json: { reconstructionAvailable: true } }),
  );
  await page.route("**/sessions", (r) =>
    r.fulfill({ status: 201, json: { sessionId: id } }),
  );
  await page.route(`**/sessions/${id}/video`, (r) => {
    uploads++;
    return r.fulfill({ status: 202, json: { sessionId: id } });
  });
  await page.route(`**/sessions/${id}/reconstruction`, (r) => {
    scheduled = true;
    return r.fulfill({ status: 202, json: { status: "queued" } });
  });
  await page.route(`**/sessions/${id}`, (r) => {
    reads++;
    return r.fulfill({
      json: {
        sessionId: id,
        status: reads === 1 ? "processing" : "done",
        reconstructionStatus: scheduled
          ? reads > 4
            ? "complete"
            : "processing"
          : "none",
        reconstructionPercent: 42,
        reconstructionMessage: "Estimando câmeras",
      },
    });
  });
  await page.route(`**/sessions/${id}/world`, (r) =>
    r.fulfill({ json: fixture }),
  );
  await page.goto("/");
  await page.locator("#video-file").setInputFiles(video);
  await page.locator("#generate").click();
  await expect(page.locator("#job-message")).toHaveText("Estimando câmeras");
  await expect(page.locator("#world-title")).toHaveText(
    "Seu mundo reconstruído",
  );
  expect(uploads).toBe(1);
  expect(scheduled).toBe(true);
  expect(page.url()).toContain(`session=${id}`);
  await page.reload();
  await expect(page.locator("#world-title")).toHaveText(
    "Seu mundo reconstruído",
  );
  expect(uploads).toBe(1);
});

test("failed saved reconstruction displays reason without automatic retry", async ({
  page,
}) => {
  let retries = 0;
  await page.route(`**/sessions/${id}`, (r) =>
    r.fulfill({
      json: {
        sessionId: id,
        status: "done",
        reconstructionStatus: "failed",
        reconstructionMessage: "Pouca textura. Mova a câmera lateralmente.",
      },
    }),
  );
  await page.route(`**/sessions/${id}/reconstruction`, (r) => {
    retries++;
    return r.fulfill({ status: 503, json: { error: "Fila cheia" } });
  });
  await page.goto(`/?session=${id}`);
  await expect(page.locator("#status")).toContainText("Pouca textura");
  expect(retries).toBe(0);
  await page.locator("#generate").click();
  await expect(page.locator("#status")).toContainText("Fila cheia");
  expect(retries).toBe(1);
});

test("missing reconstruction engine prevents an unnecessary upload", async ({
  page,
}) => {
  await page.route("**/health", (r) =>
    r.fulfill({ json: { reconstructionAvailable: false } }),
  );
  await page.goto("/");
  await page.locator("#video-file").setInputFiles(video);
  await page.locator("#generate").click();
  await expect(page.locator("#status")).toContainText(
    "motor local está indisponível",
  );
  await expect(page.locator("#generate")).toBeEnabled();
});

test("mobile layout fits viewport and keeps touch orbit available", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.locator("#example").click();
  await expect(page.locator("#orbit")).toBeEnabled();
});

test("real saved video reconstructs through FFmpeg and CPU worker", async ({
  page,
}) => {
  test.skip(
    !process.env.CLIFFLY_REAL_RECON,
    "Explicit CPU reconstruction integration run",
  );
  test.setTimeout(240000);
  await page.goto("/");
  await page
    .locator("#video-file")
    .setInputFiles(
      process.env.CLIFFLY_TEST_VIDEO || "/tmp/cliffly-multiview/room.mp4",
    );
  await page.locator("#generate").click();
  await expect(page.locator("#world-title")).toHaveText(
    "Seu mundo reconstruído",
    { timeout: 220000 },
  );
  await expect(page.locator("#metrics")).toContainText("18 vistas registradas");
  const response = await page.request.get(
    `${new URL(page.url()).searchParams.get("session") ? "/sessions/" + new URL(page.url()).searchParams.get("session") : ""}/world`,
  );
  const actual = await response.json();
  expect(actual.metrics.densePoints).toBeGreaterThan(50000);
  expect(actual.metrics.blocks).toBeGreaterThan(1000);
  await page.reload();
  await expect(page.locator("#world-title")).toHaveText(
    "Seu mundo reconstruído",
  );
  await page.screenshot({
    path: "/tmp/cliffly-reconstructed.png",
    fullPage: true,
  });
});
