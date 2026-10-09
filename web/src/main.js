import "./style.css";
import {
  buildScene,
  sampleDepth,
  serializeScene,
  parseScene,
  exportPly,
} from "./voxel.js";
import { drawDemo, demoDepth } from "./demo.js";
import { WorldRenderer } from "./renderer.js";

const $ = (id) => document.getElementById(id);
const video = $("source-video"),
  preview = $("source-preview");
const capture = document.createElement("canvas"),
  ctx = capture.getContext("2d", { willReadFrequently: true });
const original = document.createElement("canvas");
original.width = 640;
original.height = 480;
const state = {
  source: "demo",
  paused: false,
  scene: null,
  version: 0,
  sourceGeneration: 0,
  stream: null,
  url: null,
  worker: null,
  depthReady: false,
  busy: false,
  pendingFrame: null,
  lastFrame: 0,
  ticks: [],
  lastTime: 0,
};
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
let world;
try {
  world = new WorldRenderer($("world"));
} catch {
  $("webgl-error").hidden = false;
  $("freeze").disabled = true;
  $("export-open").disabled = true;
}

function status(message, error = false) {
  $("status").textContent = message;
  $("status").dataset.error = String(error);
}
function download(contents, type, extension) {
  const blob =
    contents instanceof Blob ? contents : new Blob([contents], { type });
  const url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = `cliffly-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function settings() {
  return {
    width: Number($("quality").value),
    palette: $("palette").value,
    depthStrength: Number($("depth-strength").value),
    smoothing: Number($("smoothing").value),
    mirror: $("mirror").checked,
  };
}
function saveSettings() {
  try {
    localStorage.setItem("cliffly-settings-v1", JSON.stringify(settings()));
  } catch {
    /* Storage may be disabled. */
  }
}
try {
  const s = JSON.parse(localStorage.getItem("cliffly-settings-v1") || "null");
  if (s) {
    if ([48, 80, 128].includes(s.width)) $("quality").value = String(s.width);
    if (["original", "blocks"].includes(s.palette))
      $("palette").value = s.palette;
    if (
      Number.isFinite(s.depthStrength) &&
      s.depthStrength >= 0 &&
      s.depthStrength <= 2
    )
      $("depth-strength").value = s.depthStrength;
    if (Number.isFinite(s.smoothing) && s.smoothing >= 0 && s.smoothing <= 0.9)
      $("smoothing").value = s.smoothing;
    $("mirror").checked = s.mirror === true;
  }
} catch {
  /* Invalid preferences should not prevent startup. */
}
function updateLabels() {
  $("depth-value").value = Number($("depth-strength").value).toFixed(1);
  $("smoothing-value").value =
    `${Math.round(Number($("smoothing").value) * 100)}%`;
}
updateLabels();
for (const id of [
  "quality",
  "palette",
  "depth-strength",
  "smoothing",
  "mirror",
])
  $(id).addEventListener("input", () => {
    saveSettings();
    updateLabels();
    state.version++;
    state.pendingFrame = null;
    if (state.paused && state.source !== "snapshot" && state.frozenFrame) {
      const frame = state.frozenFrame;
      applyFrame(frame, frame.depth, frame.depthMode);
    }
  });
$("compare").addEventListener("change", () => {
  world?.compare($("compare").checked);
  $("workspace").classList.toggle("compare", $("compare").checked);
});
function sourceUi() {
  const labels = {
    demo: "DEMONSTRAÇÃO",
    camera: "WEBCAM",
    video: "VÍDEO LOCAL",
    snapshot: "CENA SALVA",
    none: "CÂMERA DESLIGADA",
    pending: "CONECTANDO",
  };
  $("source-badge").textContent = labels[state.source];
  $("source-label").textContent = {
    demo: "Ambiente de exemplo",
    camera: "Captura do notebook",
    video: "Arquivo no seu dispositivo",
    snapshot: "Snapshot importado",
    none: "Sem fonte ativa",
    pending: "Aguardando permissão",
  }[state.source];
  $("source-corner").textContent =
    state.source === "camera"
      ? "WEBCAM ATIVA"
      : state.source === "video"
        ? "VÍDEO LOCAL · SEM UPLOAD"
        : "SEM CÂMERA ATIVA";
  $("camera-stop").disabled = !["camera", "pending", "video"].includes(
    state.source,
  );
  $("camera-start").disabled = state.source === "pending";
  $("quality").disabled = state.paused;
  $("mirror").disabled = state.paused;
  if (state.paused) $("fps").textContent = "—";
  $("live-badge").innerHTML = state.paused
    ? "<i></i> CONGELADA"
    : "<i></i> AO VIVO";
  $("freeze").textContent = state.paused
    ? "▶ Voltar ao vivo"
    : "Ⅱ Congelar cena";
  $("freeze").disabled =
    !world || !state.scene || ["none", "pending"].includes(state.source);
  $("interaction-hint").textContent = state.paused
    ? "Cena congelada · arraste para explorar"
    : "Arraste para explorar · role para aproximar";
}
function releaseSource() {
  state.version++;
  state.sourceGeneration++;
  state.pendingFrame = null;
  if (state.stream) {
    for (const track of state.stream.getTracks()) track.stop();
    state.stream = null;
  }
  video.pause();
  video.srcObject = null;
  video.removeAttribute("src");
  video.load();
  if (state.url) {
    URL.revokeObjectURL(state.url);
    state.url = null;
  }
  state.paused = false;
  state.frozenFrame = null;
  state.ticks = [];
}
function demo() {
  releaseSource();
  state.source = "demo";
  state.scene = null;
  world?.reset();
  sourceUi();
  status("Demo pronta. Experimente girar a cena ou conecte sua webcam.");
}
$("demo-start").addEventListener("click", demo);
$("camera-stop").addEventListener("click", () => {
  releaseSource();
  state.source = "none";
  state.paused = true;
  sourceUi();
  status("Câmera desligada. A última cena continua disponível para exportar.");
  $("accuracy").textContent =
    "Nenhuma câmera ativa. Use a webcam ou experimente a demo para continuar.";
});

async function cameras() {
  try {
    const selected = $("camera-select").value;
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === "videoinput",
    );
    $("camera-select").replaceChildren(new Option("Webcam padrão", ""));
    for (const [i, d] of devices.entries())
      $("camera-select").add(
        new Option(d.label || `Webcam ${i + 1}`, d.deviceId),
      );
    if (devices.some((d) => d.deviceId === selected))
      $("camera-select").value = selected;
  } catch {
    /* Capture works even if device enumeration is unavailable. */
  }
}
async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    status(
      "A câmera precisa de localhost ou HTTPS e de um navegador compatível.",
      true,
    );
    return;
  }
  releaseSource();
  state.source = "pending";
  const version = state.sourceGeneration;
  sourceUi();
  status("Autorize a câmera no navegador. Você pode cancelar com Desligar.");
  try {
    const device = $("camera-select").value;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        ...(device
          ? { deviceId: { exact: device } }
          : { facingMode: "environment" }),
      },
    });
    if (version !== state.sourceGeneration) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    state.stream = stream;
    video.srcObject = stream;
    await video.play();
    if (version !== state.sourceGeneration) return;
    state.source = "camera";
    state.scene = null;
    world?.reset();
    sourceUi();
    await cameras();
    stream.getVideoTracks()[0].addEventListener("ended", () => {
      if (state.stream === stream) {
        releaseSource();
        state.source = "none";
        state.paused = true;
        sourceUi();
        status("A webcam foi desconectada. Reconecte ou use a demo.", true);
      }
    });
    status(
      state.depthReady
        ? "Webcam ativa com profundidade estimada por IA."
        : "Webcam ativa. As cores e posições da imagem agora viram blocos.",
    );
  } catch (error) {
    if (version !== state.sourceGeneration) return;
    releaseSource();
    state.source = "none";
    state.paused = true;
    sourceUi();
    const messages = {
      NotAllowedError:
        "Permissão de câmera negada. Libere a câmera nas configurações do navegador e tente novamente.",
      NotFoundError:
        "Nenhuma webcam encontrada. Conecte uma câmera ou experimente a demo.",
      NotReadableError:
        "A webcam está ocupada ou indisponível. Feche outros apps que usam a câmera.",
      OverconstrainedError:
        "Essa webcam não está disponível. Escolha outra fonte.",
    };
    status(
      messages[error.name] ||
        `Não foi possível abrir a câmera: ${error.message}`,
      true,
    );
  }
}
$("camera-start").addEventListener("click", startCamera);
$("camera-select").addEventListener("change", () => {
  if (state.source === "camera") startCamera();
});
navigator.mediaDevices?.addEventListener("devicechange", cameras);

$("video-open").addEventListener("click", () => $("video-file").click());
$("video-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = "";
  releaseSource();
  state.source = "video";
  state.url = URL.createObjectURL(file);
  video.src = state.url;
  video.loop = true;
  const version = state.sourceGeneration;
  sourceUi();
  status("Abrindo vídeo local…");
  try {
    await video.play();
    if (version !== state.sourceGeneration) return;
    state.scene = null;
    world?.reset();
    sourceUi();
    status("Vídeo aberto localmente. Nenhum arquivo foi enviado ao servidor.");
  } catch {
    if (version === state.sourceGeneration) {
      releaseSource();
      state.source = "none";
      state.paused = true;
      sourceUi();
      status(
        "Não foi possível decodificar esse vídeo. Tente MP4 ou WebM.",
        true,
      );
    }
  }
});

function takeFrame(time) {
  const s = settings();
  let source;
  if (state.source === "demo") {
    drawDemo(original, reducedMotion ? 0 : time);
    source = original;
  } else {
    if (video.readyState < 2 || !video.videoWidth) return null;
    source = video;
  }
  const width = s.width,
    aspect =
      state.source === "demo" ? 4 / 3 : video.videoWidth / video.videoHeight;
  const height = Math.max(1, Math.min(120, Math.round(width / aspect)));
  capture.width = width;
  capture.height = height;
  ctx.save();
  if (s.mirror) {
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(source, 0, 0, width, height);
  ctx.restore();
  const rgba = ctx.getImageData(0, 0, width, height).data;
  // Keep the original preview at source resolution, with exactly the same mirror transform.
  preview.width =
    state.source === "demo" ? 640 : Math.min(video.videoWidth, 960);
  preview.height = Math.round(preview.width / aspect);
  const pctx = preview.getContext("2d");
  pctx.save();
  if (s.mirror) {
    pctx.translate(preview.width, 0);
    pctx.scale(-1, 1);
  }
  pctx.drawImage(source, 0, 0, preview.width, preview.height);
  pctx.restore();
  return { rgba, width, height, settings: s, time, version: state.version };
}
function applyFrame(frame, depth = null, depthMode = "plane") {
  const s = settings();
  state.scene = buildScene({
    ...frame,
    depth,
    depthMode,
    palette: s.palette,
    depthStrength: s.depthStrength,
    smoothing: s.smoothing,
    previous: state.scene,
  });
  world?.update(state.scene);
  state.frozenFrame = { ...frame, depth, depthMode };
  $("block-counter").textContent =
    `${(state.scene.points.length / 7).toLocaleString("pt-BR")} BLOCOS`;
  const modes = {
    plane: "SUPERFÍCIE PLANA",
    demo: "PROFUNDIDADE SINTÉTICA · DEMO",
    estimated: "PROFUNDIDADE RELATIVA · IA",
  };
  $("mode-label").textContent = modes[state.scene.depthMode];
  $("accuracy").textContent =
    state.source === "demo"
      ? "A demo usa um ambiente desenhado e profundidade sintética. Sua câmera ainda está desligada."
      : state.scene.depthMode === "estimated"
        ? "IA estima profundidade relativa: sem medidas em metros, geometria oculta ou reconstrução persistente."
        : "Modo básico: cores e posições reais da imagem em uma superfície plana. Ative a IA para estimar profundidade.";
  const now = performance.now();
  state.ticks = state.ticks.filter((t) => t > now - 1500);
  state.ticks.push(now);
  $("fps").textContent =
    state.ticks.length > 1
      ? (((state.ticks.length - 1) * 1000) / (now - state.ticks[0])).toFixed(1)
      : "—";
  sourceUi();
}
function tick(time) {
  requestAnimationFrame(tick);
  if (document.hidden) return;
  if (
    !state.paused &&
    ["demo", "camera", "video"].includes(state.source) &&
    time - state.lastFrame > 1000 / 24
  ) {
    state.lastFrame = time;
    if (!(state.depthReady && state.source !== "demo" && state.busy)) {
      const frame = takeFrame(time);
      if (frame) {
        if (state.source === "demo") {
          let depth = demoDepth(
            frame.width,
            frame.height,
            reducedMotion ? 0 : time,
          );
          if (frame.settings.mirror) {
            const flipped = new Float32Array(depth.length);
            for (let y = 0; y < frame.height; y++)
              for (let x = 0; x < frame.width; x++)
                flipped[y * frame.width + x] =
                  depth[y * frame.width + frame.width - 1 - x];
            depth = flipped;
          }
          applyFrame(frame, depth, "demo");
        } else if (state.depthReady) {
          state.busy = true;
          state.pendingFrame = frame;
          const fullFrame = preview
            .getContext("2d")
            .getImageData(0, 0, preview.width, preview.height);
          state.inferenceTimer = setTimeout(
            () =>
              stopDepth(
                "A IA demorou demais para processar um quadro. Tente novamente ou reduza a resolução da fonte.",
                true,
              ),
            45000,
          );
          state.worker.postMessage(
            {
              type: "infer",
              rgba: fullFrame.data,
              width: preview.width,
              height: preview.height,
              version: frame.version,
            },
            [fullFrame.data.buffer],
          );
        } else applyFrame(frame);
      }
    }
  }
  world?.render();
  if (world?.lost)
    status(
      "WebGL interrompido. Aguarde a recuperação ou recarregue a página.",
      true,
    );
}
requestAnimationFrame(tick);
sourceUi();

function freeze() {
  if (!state.scene) return;
  if (state.source === "snapshot") {
    demo();
    return;
  }
  state.paused = !state.paused;
  state.version++;
  state.pendingFrame = null;
  state.ticks = [];
  if (state.source === "video") {
    if (state.paused) video.pause();
    else
      video
        .play()
        .catch(() => status("Toque em Abrir vídeo para retomar.", true));
  }
  sourceUi();
  status(
    state.paused
      ? "Instante congelado. Explore e exporte essa cena. A webcam permanece ativa até você clicar em Desligar."
      : "Cena ao vivo novamente.",
  );
}
$("freeze").addEventListener("click", freeze);
$("reset-view").addEventListener("click", () => world?.reset());
document.addEventListener("keydown", (e) => {
  if (
    e.code === "Space" &&
    !["INPUT", "SELECT", "BUTTON", "A", "VIDEO"].includes(e.target.tagName) &&
    !document.querySelector("dialog[open]")
  ) {
    e.preventDefault();
    freeze();
  }
});
$("help-open").addEventListener("click", () => $("help").showModal());
for (const button of document.querySelectorAll("[data-close]"))
  button.addEventListener("click", () => $(button.dataset.close).close());
$("export-open").addEventListener("click", () => {
  if (state.scene) $("export").showModal();
});
$("export-json").addEventListener("click", () => {
  if (state.scene)
    download(serializeScene(state.scene), "application/json", "json");
});
$("export-ply").addEventListener("click", () => {
  if (state.scene) download(exportPly(state.scene), "text/plain", "ply");
});
$("export-png").addEventListener("click", () => {
  world?.render();
  $("world").toBlob((blob) => {
    if (blob) download(blob, "image/png", "png");
    else status("Não foi possível salvar a imagem.", true);
  });
});
$("scene-open").addEventListener("click", () => $("scene-file").click());
$("scene-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = "";
  try {
    if (file.size > 12_000_000)
      throw new Error("Arquivo muito grande. Limite: 12 MB.");
    const scene = parseScene(await file.text());
    releaseSource();
    state.source = "snapshot";
    state.paused = true;
    state.scene = scene;
    world?.reset();
    world?.update(scene);
    $("block-counter").textContent =
      `${(scene.points.length / 7).toLocaleString("pt-BR")} BLOCOS`;
    $("mode-label").textContent = {
      plane: "SUPERFÍCIE PLANA",
      demo: "PROFUNDIDADE SINTÉTICA · DEMO",
      estimated: "PROFUNDIDADE RELATIVA · IA",
    }[scene.depthMode];
    $("accuracy").textContent =
      "Cena importada em unidades relativas. O arquivo contém a superfície observada, sem uma imagem original.";
    preview.getContext("2d").clearRect(0, 0, preview.width, preview.height);
    sourceUi();
    $("fps").textContent = "—";
    status(
      "Cena reaberta. Explore ou clique em Voltar ao vivo para iniciar a demo.",
    );
  } catch (error) {
    status(error.message, true);
  }
});

function stopDepth(message, error = false) {
  clearTimeout(state.depthDownloadTimer);
  clearTimeout(state.inferenceTimer);
  state.worker?.terminate();
  state.worker = null;
  state.depthReady = false;
  state.busy = false;
  state.pendingFrame = null;
  state.version++;
  $("depth-enable").disabled = false;
  $("depth-enable").textContent = "◇ Ativar profundidade IA";
  $("depth-timing").textContent = "Imagem local · sem upload";
  if (message) status(message, error);
}
$("depth-enable").addEventListener("click", () => {
  if (state.worker) {
    stopDepth("Profundidade IA desligada. A captura volta ao modo básico.");
    return;
  }
  $("depth-enable").disabled = true;
  status(
    "Baixando o modelo de profundidade. A primeira ativação precisa de internet e pode levar alguns minutos.",
  );
  let worker;
  try {
    worker = new Worker(new URL("./depth-worker.js", import.meta.url), {
      type: "module",
    });
  } catch {
    stopDepth("Esse navegador não conseguiu iniciar o worker de IA.", true);
    return;
  }
  state.worker = worker;
  $("depth-enable").disabled = false;
  $("depth-enable").textContent = "Cancelar download IA";
  state.depthDownloadTimer = setTimeout(() => {
    if (state.worker === worker && !state.depthReady)
      stopDepth(
        "Download da IA demorou demais. Verifique sua conexão e tente novamente.",
        true,
      );
  }, 180000);
  worker.onerror = () => {
    if (state.worker === worker)
      stopDepth(
        "Não foi possível iniciar a IA. O modo básico continua disponível.",
        true,
      );
  };
  worker.onmessage = ({ data }) => {
    if (state.worker !== worker) return;
    if (data.type === "progress") {
      $("depth-enable").textContent = `IA · ${data.message}`;
    }
    if (data.type === "ready") {
      clearTimeout(state.depthDownloadTimer);
      state.depthReady = true;
      state.version++;
      $("depth-enable").disabled = false;
      $("depth-enable").textContent = "◇ Desligar profundidade IA";
      status(
        state.source === "demo"
          ? "IA pronta. Conecte uma webcam ou abra um vídeo para usar a estimativa. A demo mantém sua profundidade sintética."
          : "IA pronta. Estimando profundidade localmente…",
      );
    }
    if (data.type === "result") {
      clearTimeout(state.inferenceTimer);
      state.busy = false;
      const frame = state.pendingFrame;
      state.pendingFrame = null;
      if (frame && frame.version === state.version && !state.paused) {
        const depth = sampleDepth(
          data.depth,
          data.width,
          data.height,
          frame.width,
          frame.height,
          data.channels,
        );
        applyFrame(frame, depth, "estimated");
        $("depth-timing").textContent =
          `IA ${data.backend.toUpperCase()}: ${(data.elapsed / 1000).toFixed(2)} s / quadro`;
      }
    }
    if (data.type === "error")
      stopDepth(
        `IA indisponível: ${data.message}. O modo básico continua disponível.`,
        true,
      );
  };
  worker.postMessage({ type: "load" });
});
window.addEventListener("pagehide", () => {
  releaseSource();
  state.worker?.terminate();
  world?.dispose();
});
