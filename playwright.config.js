import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "web/e2e",
  outputDir: process.env.CLIFFLY_REAL_DEPTH
    ? "test-results-depth"
    : "test-results",
  timeout: 30000,
  workers: 1,
  use: {
    baseURL: "http://localhost:5174",
    headless: true,
    launchOptions: {
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--enable-unsafe-swiftshader",
        ...(process.env.CLIFFLY_REAL_GUIDE
          ? [
              `--use-file-for-fake-video-capture=${process.env.CLIFFLY_TEST_GUIDE_VIDEO || "/tmp/cliffly-multiview/camera.y4m"}`,
            ]
          : []),
      ],
    },
    permissions: ["camera"],
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "npm run preview -- --port 5174 --strictPort",
      url: "http://localhost:5174",
      reuseExistingServer: !process.env.CI,
    },
    ...(process.env.CLIFFLY_REAL_RECON || process.env.CLIFFLY_REAL_GUIDE
      ? [
          {
            command:
              "dotnet run --project Cliffly -c Release --no-build --no-launch-profile",
            url: "http://localhost:5000/health",
            reuseExistingServer: !process.env.CI,
            env: { CaptureRoot: "/tmp/cliffly-browser-captures" },
            timeout: 60000,
          },
        ]
      : []),
  ],
});
