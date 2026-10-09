import { test, expect } from "@playwright/test";

const scanId = "aaaaaaaa-1234-1234-1234-123456789abc";
const basePoints = [
  0, 0, -5, 1, 170, 90, 40, 1, 0, -5, 1, 40, 150, 70, 0, 1, -5, 1, 90, 120, 170,
];
function preview(revision) {
  const points = [...basePoints];
  for (let i = 1; i < revision; i++) points.push(-i, 0, -5, 1, 110, 100, 60);
  const confidence = points
    .filter((_, i) => i % 7 === 0)
    .map((_, i) => (i % 2 ? 1 : 0.4));
  return {
    version: 2,
    kind: "voxel-world",
    preview: true,
    voxelSize: 1,
    points,
    confidence,
    cameras: [
      { position: [0, 0, 0], target: [0, 0, -5] },
      { position: [1, 0, 0], target: [1, 0, -5] },
    ],
    metrics: { registeredFrames: 2 },
    warnings: ["Prévia aproximada. Espaços vazios são desconhecidos."],
  };
}

test("guided recording grows a persistent preview, shows coverage and preserves navigation", async ({
  page,
}) => {
  let frames = 0,
    stops = 0;
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/scans", (r) =>
    r.fulfill({ status: 201, json: { scanId, status: "active" } }),
  );
  await page.route(`**/scans/${scanId}/frames`, (r) => {
    expect(r.request().headers()["content-type"]).toBe("image/jpeg");
    expect(r.request().postDataBuffer().length).toBeGreaterThan(500);
    frames++;
    return r.fulfill({
      json: {
        status: "active",
        preview: {
          revision: frames,
          tracking: "tracking",
          message: "Observe a região direita por outro ângulo.",
          targetRegion: [2 / 3, 0, 1 / 3, 1],
          keyframes: frames + 1,
          blocks: frames + 2,
          milliseconds: 90,
          camera: { position: [0, 0, 0], target: [0, 0, -5] },
        },
      },
    });
  });
  await page.route(`**/scans/${scanId}/world`, (r) =>
    r.fulfill({ json: preview(frames) }),
  );
  await page.route(`**/scans/${scanId}/stop`, (r) => {
    stops++;
    return r.fulfill({ json: { status: "stopped" } });
  });
  await page.goto("/");
  await page.locator("#record").click();
  await expect(page.locator("#world-title")).toHaveText(
    "Prévia · escaneando o ambiente",
  );
  await expect(page.locator("#coverage")).toBeChecked();
  await expect(page.locator("#coverage-legend")).toBeVisible();
  await expect(page.locator("#guide-target")).toBeVisible();
  await expect(page.locator("#guide-message")).toContainText("região direita");
  await page.locator("#free").click();
  await expect.poll(() => frames).toBeGreaterThan(2);
  await expect(page.locator("#free")).toHaveClass(/active/);
  await page.locator("#coverage").uncheck();
  await expect(page.locator("#coverage-legend")).toBeHidden();
  await page.locator("#stop").click();
  await expect(page.locator("#guide-state")).toHaveText("ENCERRADA");
  expect(stops).toBe(1);
  await expect(page.locator("#guide-target")).toBeHidden();
  await expect(page.locator("#generate")).toBeEnabled();
  await expect(page.locator("#generate")).toContainText("Refinar");
  await expect(page.locator("#world-title")).toHaveText(
    "Prévia · escaneando o ambiente",
  );
  expect(errors).toEqual([]);
  await page.screenshot({ path: "/tmp/cliffly-guided.png", fullPage: true });
});

test("preview failure keeps the complete recording usable", async ({
  page,
}) => {
  await page.route("**/scans", (r) =>
    r.fulfill({ status: 503, json: { error: "Prévia indisponível." } }),
  );
  await page.goto("/");
  await page.locator("#record").click();
  await expect(page.locator("#guide-message")).toContainText(
    "vídeo continua sendo gravado",
  );
  await expect(page.locator("#stop")).toBeVisible();
  await page.waitForTimeout(1200);
  await page.locator("#stop").click();
  await expect(page.locator("#generate")).toBeEnabled();
  await expect(page.locator("#save-video")).toBeEnabled();
});

test("user can record without sending any preview frames", async ({ page }) => {
  let scans = 0;
  page.on("request", (r) => {
    if (r.url().includes("/scans")) scans++;
  });
  await page.goto("/");
  await page.locator("#guided-enabled").uncheck();
  await page.locator("#record").click();
  await expect(page.locator("#stop")).toBeVisible();
  await page.waitForTimeout(1100);
  await page.locator("#stop").click();
  await expect(page.locator("#generate")).toBeEnabled();
  expect(scans).toBe(0);
});

test("loss of tracking retains valid geometry and asks user to return", async ({
  page,
}) => {
  let frames = 0;
  await page.route("**/scans", (r) =>
    r.fulfill({ status: 201, json: { scanId } }),
  );
  await page.route(`**/scans/${scanId}/frames`, (r) =>
    r.fulfill({
      json: {
        status: "active",
        preview: {
          revision: 1,
          tracking: ++frames === 1 ? "tracking" : "lost",
          message: frames === 1 ? "Mapeando" : "Volte à região já observada.",
          targetRegion: null,
          keyframes: 2,
          blocks: 3,
          milliseconds: 90,
          camera: { position: [0, 0, 0], target: [0, 0, -5] },
        },
      },
    }),
  );
  await page.route(`**/scans/${scanId}/world`, (r) =>
    r.fulfill({ json: preview(1) }),
  );
  await page.route(`**/scans/${scanId}/stop`, (r) =>
    r.fulfill({ json: { status: "stopped" } }),
  );
  await page.goto("/");
  await page.locator("#record").click();
  await expect(page.locator("#guide-message")).toContainText("Volte à região");
  await expect(page.locator("#world-count")).toHaveText("3 BLOCOS");
  await expect(page.locator("#guide-target")).toBeHidden();
  await page.locator("#stop").click();
});

test("stopping while preview startup is pending closes the late worker", async ({
  page,
}) => {
  let release,
    stops = 0;
  const pending = new Promise((resolve) => (release = resolve));
  await page.route("**/scans", async (r) => {
    await pending;
    await r.fulfill({ status: 201, json: { scanId } });
  });
  await page.route(`**/scans/${scanId}/stop`, (r) => {
    stops++;
    return r.fulfill({ json: { status: "stopped" } });
  });
  await page.goto("/");
  await page.locator("#record").click();
  await expect(page.locator("#stop")).toBeVisible();
  await page.locator("#stop").click();
  release();
  await expect.poll(() => stops).toBe(1);
  await expect(page.locator("#generate")).toBeEnabled();
});

test("real moving camera builds geometry while recording through the API", async ({
  page,
}) => {
  test.skip(
    !process.env.CLIFFLY_REAL_GUIDE,
    "Explicit guided camera integration run",
  );
  test.setTimeout(120000);
  let scanId,
    frames = 0;
  page.on("response", async (response) => {
    if (response.url().endsWith("/scans") && response.status() === 201)
      scanId = (await response.json()).scanId;
    if (response.url().endsWith("/frames") && response.status() === 200)
      frames++;
  });
  await page.goto("/");
  await page.locator("#record").click();
  await expect(page.locator("#world-title")).toHaveText(
    "Prévia · escaneando o ambiente",
    { timeout: 75000 },
  );
  await expect.poll(() => frames, { timeout: 30000 }).toBeGreaterThan(10);
  await expect(page.locator("#stop")).toBeVisible();
  const world = await (await page.request.get(`/scans/${scanId}/world`)).json();
  expect(world.preview).toBe(true);
  expect(world.metrics.blocks).toBeGreaterThan(500);
  expect(world.cameras.length).toBeGreaterThanOrEqual(3);
  expect(world.confidence.length).toBe(world.points.length / 7);
  await page.locator("#stop").click();
  await expect(page.locator("#generate")).toBeEnabled();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/scans/${scanId}`)).json()).status,
    )
    .toBe("stopped");
  const download = page.waitForEvent("download");
  await page.locator("#save-video").click();
  await download;
  await page.screenshot({
    path: "/tmp/cliffly-guided-real.png",
    fullPage: true,
  });
});
