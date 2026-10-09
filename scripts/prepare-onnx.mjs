import { mkdir, copyFile } from "node:fs/promises";
const directory = new URL("../web/public/onnx/", import.meta.url);
await mkdir(directory, { recursive: true });
for (const file of [
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
]) {
  await copyFile(
    new URL(
      `../node_modules/@huggingface/transformers/dist/${file}`,
      import.meta.url,
    ),
    new URL(file, directory),
  );
}
