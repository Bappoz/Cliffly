import { spawn } from "node:child_process";
const command = spawn(
  process.execPath,
  [
    "node_modules/@playwright/test/cli.js",
    "test",
    "--grep",
    "real browser model",
  ],
  {
    stdio: "inherit",
    env: { ...process.env, CLIFFLY_REAL_DEPTH: "1" },
  },
);
command.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
