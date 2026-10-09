import { test, expect } from "@playwright/test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ready = async (page) => {
  await page.goto("/");
  await expect(page.locator("#block-counter")).not.toHaveText("0 BLOCOS");
};

test("demo renders, freezes and exports a reimportable scene", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page);
  await expect(page.locator("#source-badge")).toHaveText("DEMONSTRAÇÃO");
  await expect(page.locator("#webgl-error")).toBeHidden();
  await page.getByRole("button", { name: "Congelar cena" }).click();
  await expect(page.locator("#live-badge")).toContainText("CONGELADA");
  await page.getByRole("button", { name: "Exportar", exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#export-json").click();
  const saved = await downloadPromise;
  const contents = await readFile(await saved.path(), "utf8");
  const scene = JSON.parse(contents);
  expect(scene.version).toBe(1);
  expect(scene.points.length).toBe(scene.width * scene.height * 7);
  await page.getByRole("button", { name: "Fechar exportação" }).click();
  await page.locator("#scene-file").setInputFiles({
    name: "scene.json",
    mimeType: "application/json",
    buffer: Buffer.from(contents),
  });
  await expect(page.locator("#source-badge")).toHaveText("CENA SALVA");
  await expect(page.locator("#status")).toContainText("Cena reaberta");
  await page.locator("#world").focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Home");
  expect(errors).toEqual([]);
});

test("webcam starts only on request and stop releases every track", async ({
  page,
}) => {
  await ready(page);
  expect(
    await page.locator("#source-video").evaluate((v) => v.srcObject),
  ).toBeNull();
  await page.getByRole("button", { name: "Usar webcam" }).click();
  await expect(page.locator("#source-badge")).toHaveText("WEBCAM");
  await expect(page.locator("#mode-label")).toHaveText("SUPERFÍCIE PLANA");
  await page.evaluate(() => {
    window.testTracks = document
      .getElementById("source-video")
      .srcObject.getTracks();
  });
  await page.getByRole("button", { name: "Congelar cena" }).click();
  await expect(page.locator("#live-badge")).toContainText("CONGELADA");
  await page.getByRole("button", { name: "Desligar", exact: true }).click();
  await expect(page.locator("#source-badge")).toHaveText("CÂMERA DESLIGADA");
  expect(
    await page.evaluate(() =>
      window.testTracks.every((t) => t.readyState === "ended"),
    ),
  ).toBe(true);
});

test("camera permission failure offers a recoverable message", async ({
  page,
}) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Denied", "NotAllowedError");
    };
  });
  await ready(page);
  await page.getByRole("button", { name: "Usar webcam" }).click();
  await expect(page.locator("#status")).toContainText(
    "Permissão de câmera negada",
  );
  await page.getByRole("button", { name: "Experimentar demo" }).click();
  await expect(page.locator("#source-badge")).toHaveText("DEMONSTRAÇÃO");
});

test("malformed snapshots do not destroy the current scene", async ({
  page,
}) => {
  await ready(page);
  await page.locator("#scene-file").setInputFiles({
    name: "bad.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"version":99}'),
  });
  await expect(page.locator("#status")).toContainText("incompatível");
  await expect(page.locator("#source-badge")).toHaveText("DEMONSTRAÇÃO");
});

test("settings persist, keyboard freezes, mobile layout fits", async ({
  page,
}) => {
  await ready(page);
  await page.locator("#quality").selectOption("48");
  await page.locator("#palette").selectOption("blocks");
  await page.reload();
  await expect(page.locator("#quality")).toHaveValue("48");
  await expect(page.locator("#palette")).toHaveValue("blocks");
  await expect(page.locator("#block-counter")).not.toHaveText("0 BLOCOS");
  await page.locator("#world").focus();
  await page.keyboard.press("Space");
  await expect(page.locator("#live-badge")).toContainText("CONGELADA");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Como funciona" }).click();
  await expect(page.locator("#help")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#help")).toBeHidden();
});

test("model network failure falls back without stopping the demo", async ({
  page,
}) => {
  await page.route("https://huggingface.co/**", (route) => route.abort());
  await ready(page);
  await page.locator("#depth-enable").click();
  await expect(page.locator("#status")).toContainText("IA indisponível", {
    timeout: 30000,
  });
  await expect(page.locator("#depth-enable")).toContainText(
    "Ativar profundidade IA",
  );
  await expect(page.locator("#source-badge")).toHaveText("DEMONSTRAÇÃO");
});

test("PLY and PNG exports create real files", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "Exportar", exact: true }).click();
  let promise = page.waitForEvent("download");
  await page.locator("#export-ply").click();
  let file = await promise;
  expect((await readFile(await file.path(), "utf8")).startsWith("ply\n")).toBe(
    true,
  );
  promise = page.waitForEvent("download");
  await page.locator("#export-png").click();
  file = await promise;
  const bytes = await readFile(await file.path());
  expect(Array.from(bytes.subarray(0, 8))).toEqual([
    137, 80, 78, 71, 13, 10, 26, 10,
  ]);
});

test("real browser model performs depth inference", async ({ page }) => {
  test.skip(
    !process.env.CLIFFLY_REAL_DEPTH,
    "Opt-in: downloads actual model weights",
  );
  test.setTimeout(240000);
  await ready(page);
  await page.getByRole("button", { name: "Usar webcam" }).click();
  await expect(page.locator("#source-badge")).toHaveText("WEBCAM");
  await page.locator("#depth-enable").click();
  await expect(page.locator("#mode-label")).toHaveText(
    "PROFUNDIDADE RELATIVA · IA",
    { timeout: 200000 },
  );
  await expect(page.locator("#depth-timing")).toContainText("s / quadro");
  console.log(
    "Real depth timing:",
    await page.locator("#depth-timing").textContent(),
  );
  await page.getByRole("button", { name: "Congelar cena" }).click();
  await page.getByRole("button", { name: "Exportar", exact: true }).click();
  const promise = page.waitForEvent("download");
  await page.locator("#export-json").click();
  const file = await promise;
  const scene = JSON.parse(await readFile(await file.path(), "utf8"));
  const z = scene.points.filter((_, i) => i % 7 === 2);
  expect(Math.max(...z) - Math.min(...z)).toBeGreaterThan(1);
});

test("changing detail during permission request does not cancel the camera", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      return original(constraints);
    };
  });
  await ready(page);
  await page.getByRole("button", { name: "Usar webcam" }).click();
  await page.locator("#quality").selectOption("48");
  await expect(page.locator("#source-badge")).toHaveText("WEBCAM");
});

test("local video decodes without an automatic backend upload", async ({
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "cliffly-video-test-"));
  const path = join(directory, "fixture.webm");
  try {
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=64x48:r=10",
      "-t",
      "2",
      "-c:v",
      "libvpx",
      path,
    ]);
    const uploads = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/sessions"))
        uploads.push(request.url());
    });
    await ready(page);
    await page.locator("#video-file").setInputFiles(path);
    await expect(page.locator("#status")).toContainText(
      "Vídeo aberto localmente",
    );
    await expect(page.locator("#source-badge")).toHaveText("VÍDEO LOCAL");
    await expect(page.locator("#mode-label")).toHaveText("SUPERFÍCIE PLANA");
    await page.getByRole("button", { name: "Congelar cena" }).click();
    expect(await page.locator("#source-video").evaluate((v) => v.paused)).toBe(
      true,
    );
    expect(uploads).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
