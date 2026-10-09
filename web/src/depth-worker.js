import { pipeline, env, RawImage } from "@huggingface/transformers";

// Ship the ONNX runtime locally. Only model weights come from the Hub.
env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = new URL("/onnx/", self.location.origin).href;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;
let estimator = null,
  busy = false,
  backend = "wasm";
const model = "onnx-community/depth-anything-v2-small";
function progress(p) {
  if (p.status === "progress")
    self.postMessage({
      type: "progress",
      message: `${Math.round(p.progress)}%`,
    });
  else if (p.status === "initiate")
    self.postMessage({ type: "progress", message: "baixando modelo…" });
}
async function loadEstimator(device) {
  const pipe = await pipeline("depth-estimation", model, {
    device,
    dtype: device === "webgpu" ? "fp32" : "q8",
    progress_callback: progress,
  });
  const processor =
    pipe.processor.image_processor ??
    pipe.processor.feature_extractor ??
    pipe.processor;
  // Multiples of the 14-pixel patch size. Lower resolution is a deliberate
  // latency/edge-detail tradeoff for live use, independent of voxel resolution.
  processor.size = { width: 224, height: 224 };
  return pipe;
}
self.onmessage = async ({ data }) => {
  try {
    if (data.type === "load") {
      try {
        const adapter = await navigator.gpu?.requestAdapter({
          powerPreference: "high-performance",
        });
        if (adapter && !adapter.isFallbackAdapter) backend = "webgpu";
      } catch {
        backend = "wasm";
      }
      try {
        estimator = await loadEstimator(backend);
      } catch (error) {
        if (backend === "wasm") throw error;
        backend = "wasm";
        self.postMessage({
          type: "progress",
          message: "GPU indisponível, usando CPU…",
        });
        estimator = await loadEstimator(backend);
      }
      self.postMessage({ type: "ready", backend });
    }
    if (data.type === "infer" && estimator && !busy) {
      busy = true;
      const start = performance.now();
      const result = await estimator(
        new RawImage(data.rgba, data.width, data.height, 4),
      );
      const depth = result.depth;
      self.postMessage(
        {
          type: "result",
          depth: depth.data,
          width: depth.width,
          height: depth.height,
          channels: depth.channels,
          version: data.version,
          backend,
          elapsed: performance.now() - start,
        },
        [depth.data.buffer],
      );
      busy = false;
    }
  } catch (error) {
    busy = false;
    self.postMessage({
      type: "error",
      message: error.message || "Falha no modelo de profundidade",
    });
  }
};
