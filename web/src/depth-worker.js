import { pipeline, env, RawImage } from '@huggingface/transformers';

// Ship the ONNX runtime locally. Only model weights come from the Hub.
env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = new URL('/onnx/', self.location.origin).href;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;
let estimator = null, busy = false;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      estimator = await pipeline('depth-estimation', 'onnx-community/depth-anything-v2-small', {
        device: 'wasm', dtype: 'q8',
        progress_callback: p => {
          if (p.status === 'progress') self.postMessage({ type: 'progress', message: `${Math.round(p.progress)}%` });
          else if (p.status === 'initiate') self.postMessage({ type: 'progress', message: 'baixando modelo…' });
        },
      });
      self.postMessage({ type: 'ready' });
    }
    if (data.type === 'infer' && estimator && !busy) {
      busy = true;
      const start = performance.now();
      const result = await estimator(new RawImage(data.rgba, data.width, data.height, 4));
      const depth = result.depth;
      self.postMessage({ type: 'result', depth: depth.data, width: depth.width, height: depth.height,
        channels: depth.channels, version: data.version, elapsed: performance.now() - start }, [depth.data.buffer]);
      busy = false;
    }
  } catch (error) {
    busy = false;
    self.postMessage({ type: 'error', message: error.message || 'Falha no modelo de profundidade' });
  }
};
