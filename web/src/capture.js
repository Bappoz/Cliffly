import "./capture.css";
import { WorldViewer } from "./world-viewer.js";
import { validateWorld, worldPly } from "./world-file.js";
import { GuidedCapture } from "./guided-capture.js";

const $ = (id) => document.getElementById(id);
const LIMIT = 128 * 1024 * 1024;
let stream,
  recorder,
  chunks = [],
  clock,
  localVideo,
  videoUrl,
  world,
  sessionId,
  busy = false,
  recording = false,
  generation = 0;
let viewer;
let guidePhase = "idle",
  guideRegion = null;
const guide = new GuidedCapture({
  started: () => {
    guidePhase = "active";
    world = null;
    viewer?.clearWorld();
    $("world-empty").hidden = false;
    $("world-title").textContent = "Prévia · aguardando novas vistas";
    $("world-count").textContent = "0 BLOCOS";
    $("world-details").hidden = true;
    for (const id of [
      "orbit",
      "free",
      "reset",
      "path",
      "coverage",
      "export-world",
      "export-ply",
    ])
      $(id).disabled = true;
    $("guide-panel").hidden = false;
    $("guide-state").textContent = "INICIANDO";
    $("guide-message").textContent =
      "Desloque a câmera devagar para obter as primeiras vistas.";
    $("coverage").checked = true;
  },
  state: (state) => {
    const labels = {
      initializing: "NOVAS VISTAS",
      tracking: "ACOMPANHANDO",
      lost: "VOLTE À REGIÃO VISTA",
      blur: "ESTABILIZE",
      low_texture: "BUSQUE DETALHES",
    };
    $("guide-state").textContent = labels[state.tracking] || "ACOMPANHANDO";
    $("guide-state").dataset.tracking = state.tracking;
    $("guide-message").textContent = state.message;
    $("guide-stats").textContent =
      `${state.keyframes} vistas úteis · ${state.blocks.toLocaleString("pt-BR")} blocos · ${state.milliseconds} ms nesta amostra`;
    viewer?.showGuideCamera(state.camera, state.tracking !== "tracking");
    guideRegion = state.tracking === "tracking" ? state.targetRegion : null;
    positionGuideRegion();
  },
  world: (value) => {
    displayWorld(value, "Prévia · escaneando o ambiente", {
      preserveView: true,
    });
    viewer?.showGuideCamera(value.cameras.at(-1));
  },
  error: (message) => {
    guidePhase = "error";
    $("guide-panel").hidden = false;
    $("guide-state").textContent = "SEM PRÉVIA";
    $("guide-state").dataset.tracking = "error";
    $("guide-message").textContent =
      `${message} O vídeo continua sendo gravado.`;
    guideRegion = null;
    positionGuideRegion();
  },
  stopped: () => {
    if (guidePhase === "active") {
      $("guide-state").textContent = "ENCERRADA";
      $("guide-message").textContent = world?.preview
        ? "Prévia preservada. Agora refine o mundo usando a gravação completa."
        : "Finalize a análise do vídeo para tentar reconstruir o ambiente.";
      guidePhase = "stopped";
    }
    guideRegion = null;
    positionGuideRegion();
  },
});

function positionGuideRegion() {
  const target = $("guide-target"),
    video = $("capture-video");
  target.hidden = !guideRegion || !recording;
  if (target.hidden) return;
  const parent = video.parentElement;
  const ratio = video.videoWidth / video.videoHeight;
  const w = Math.min(parent.clientWidth, parent.clientHeight * ratio),
    h = w / ratio;
  const [x, y, width, height] = guideRegion;
  Object.assign(target.style, {
    left: `${(parent.clientWidth - w) / 2 + x * w}px`,
    top: `${(parent.clientHeight - h) / 2 + y * h}px`,
    width: `${width * w}px`,
    height: `${height * h}px`,
  });
}
new ResizeObserver(positionGuideRegion).observe(
  $("capture-video").parentElement,
);
try {
  viewer = new WorldViewer($("world-canvas"), (mode) => {
    $("orbit").classList.toggle("active", mode === "orbit");
    $("free").classList.toggle("active", mode === "free");
    $("view-label").textContent =
      mode === "free" ? "EXPLORANDO · ESC LIBERA O MOUSE" : "VISÃO GERAL";
    $("crosshair").hidden = mode !== "free";
    $("navigation-help").textContent =
      mode === "free"
        ? "Clique na cena · WASD move · E/espaço sobe · Q desce · Shift acelera · setas orientam · Esc libera · sem colisões"
        : "Arraste para orbitar · rolagem para aproximar · Home para voltar";
  });
  const animate = (now) => {
    viewer.render(now);
    requestAnimationFrame(animate);
  };
  requestAnimationFrame(animate);
} catch {
  $("webgl-error").hidden = false;
}

function status(message, error = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", error);
}
function controls() {
  $("record").disabled = busy || recording;
  $("record").hidden = recording;
  $("stop").hidden = !recording;
  $("video-file").disabled = busy || recording;
  $("world-file").disabled = busy || recording;
  $("guided-enabled").disabled = busy || recording;
  $("generate").disabled = busy || recording || (!localVideo && !sessionId);
  $("save-video").disabled = (!localVideo && !sessionId) || recording;
  $("example").disabled = busy || recording;
  for (const button of $("recent-list").querySelectorAll("button"))
    button.disabled = busy || recording;
}
function releaseCamera() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
}
function clearSession() {
  sessionId = null;
  const url = new URL(location.href);
  url.searchParams.delete("session");
  history.replaceState(null, "", url);
  $("job").hidden = true;
}
function download(blob, name) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function setVideo(blob) {
  if (blob.size > LIMIT || !blob.size)
    throw new Error("Escolha um vídeo de até 128 MiB.");
  releaseCamera();
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  localVideo = blob;
  videoUrl = URL.createObjectURL(blob);
  $("capture-video").srcObject = null;
  $("capture-video").src = videoUrl;
  $("capture-video").controls = true;
  $("capture-empty").hidden = true;
  $("record-clock").hidden = true;
  $("video-info").textContent =
    `${(blob.size / 1024 / 1024).toFixed(1)} MiB · gravação pronta para revisar`;
  $("generate").innerHTML = world?.preview
    ? "Refinar e gerar mundo <span>→</span>"
    : "Salvar e gerar mundo <span>→</span>";
  clearSession();
  controls();
  status("Gravação pronta. Reveja, baixe se quiser e inicie a reconstrução.");
}
$("record").addEventListener("click", async () => {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    status(
      "Este navegador não oferece gravação. Importe um vídeo ou use Chrome/Edge/Firefox em localhost ou HTTPS.",
      true,
    );
    return;
  }
  busy = true;
  controls();
  status("Aguardando permissão da câmera…");
  try {
    releaseCamera();
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    const mimeType = ["video/webm;codecs=vp8", "video/webm", "video/mp4"].find(
      (type) => MediaRecorder.isTypeSupported(type),
    );
    recorder = new MediaRecorder(
      stream,
      mimeType ? { mimeType, videoBitsPerSecond: 3500000 } : {},
    );
    chunks = [];
    let bytes = 0;
    recorder.ondataavailable = (event) => {
      if (event.data.size) {
        chunks.push(event.data);
        bytes += event.data.size;
      }
      if (bytes > LIMIT - 1024 * 1024 && recorder.state === "recording")
        recorder.stop();
    };
    recorder.onstop = () => {
      clearInterval(clock);
      guide.stop();
      releaseCamera();
      recording = false;
      try {
        setVideo(new Blob(chunks, { type: recorder.mimeType }));
      } catch (error) {
        status(error.message, true);
        controls();
      }
      chunks = [];
    };
    recorder.onerror = () => {
      guide.stop();
      releaseCamera();
      clearInterval(clock);
      recording = false;
      busy = false;
      controls();
      status("Falha ao gravar. Tente novamente ou importe um vídeo.", true);
    };
    $("capture-video").removeAttribute("src");
    $("capture-video").srcObject = stream;
    $("capture-video").controls = false;
    await $("capture-video").play();
    $("capture-empty").hidden = true;
    $("record-clock").hidden = false;
    clearSession();
    recording = true;
    recorder.start(1000);
    if ($("guided-enabled").checked) guide.start($("capture-video"));
    else $("guide-panel").hidden = true;
    const start = performance.now();
    clock = setInterval(() => {
      const seconds = Math.floor((performance.now() - start) / 1000);
      $("record-clock").textContent =
        `● ${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
      if (seconds >= 120 && recorder.state === "recording") recorder.stop();
    }, 250);
    status(
      "Gravando. Desloque a câmera lentamente para mostrar novas perspectivas.",
    );
  } catch (error) {
    releaseCamera();
    status(
      error.name === "NotAllowedError"
        ? "Permissão da câmera negada. Você pode importar um vídeo."
        : "Não foi possível iniciar a câmera. Confira se ela está disponível.",
      true,
    );
  } finally {
    busy = false;
    controls();
  }
});
$("stop").addEventListener("click", () => {
  if (recorder?.state === "recording") recorder.stop();
});
$("video-file").addEventListener("change", (event) => {
  const file = event.target.files[0];
  try {
    if (file) setVideo(file);
  } catch (error) {
    status(error.message, true);
  }
  event.target.value = "";
});
$("save-video").addEventListener("click", () => {
  if (localVideo)
    download(
      localVideo,
      localVideo instanceof File
        ? localVideo.name
        : `cliffly-captura.${localVideo.type.includes("mp4") ? "mp4" : "webm"}`,
    );
  else if (sessionId) {
    const a = document.createElement("a");
    a.href = `/sessions/${sessionId}/video`;
    a.click();
  }
});

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    signal: AbortSignal.timeout(
      options.body instanceof FormData ? 120000 : 20000,
    ),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      body.error ||
        (response.status === 404
          ? "Captura não encontrada neste servidor."
          : `Servidor respondeu ${response.status}. Tente novamente.`),
    );
  }
  return response.json();
}
function remember(id) {
  try {
    const previous = JSON.parse(
      localStorage.getItem("cliffly-captures") || "[]",
    );
    const list = [
      { id, date: new Date().toISOString() },
      ...previous.filter((entry) => entry.id !== id),
    ].slice(0, 8);
    localStorage.setItem("cliffly-captures", JSON.stringify(list));
  } catch {
    /* Session URL remains usable if storage is disabled. */
  }
  const url = new URL(location.href);
  url.searchParams.set("session", id);
  history.replaceState(null, "", url);
  showRecent();
}
function showRecent() {
  $("recent-list").replaceChildren();
  try {
    const entries = JSON.parse(
      localStorage.getItem("cliffly-captures") || "[]",
    );
    for (const entry of entries.slice(0, 8)) {
      if (!/^[a-f0-9-]{36}$/i.test(entry.id)) continue;
      const button = document.createElement("button");
      button.textContent = `↗ ${new Date(entry.date).toLocaleString("pt-BR")} · ${entry.id.slice(0, 8)}`;
      button.onclick = () => processCapture(entry.id);
      $("recent-list").append(button);
    }
  } catch {
    /* Ignore corrupted history. */
  }
  $("recent").hidden = !$("recent-list").children.length;
  controls();
}
function job(message, percent = null, stage = "Reconstruindo") {
  $("job").hidden = false;
  $("job-message").textContent = message;
  $("job-stage").textContent = stage;
  $("job-percent").textContent = percent === null ? "" : `${percent}%`;
  if (percent === null) $("job-progress").removeAttribute("value");
  else $("job-progress").value = percent;
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function processCapture(existingId, retry = false) {
  if (busy || recording) return;
  busy = true;
  const current = ++generation;
  controls();
  try {
    if (existingId) {
      sessionId = existingId;
      localVideo = null;
      remember(sessionId);
    }
    let session;
    if (!sessionId) {
      if (!localVideo) throw new Error("Grave ou importe um vídeo primeiro.");
      const health = await api("/health");
      if (!health.reconstructionAvailable)
        throw new Error(
          "O motor local está indisponível. Consulte a instalação no README do projeto.",
        );
      job("Salvando vídeo no servidor…", null, "Salvando captura");
      session = await api("/sessions", { method: "POST" });
      const form = new FormData();
      form.append(
        "video",
        localVideo,
        localVideo instanceof File
          ? localVideo.name
          : `capture.${localVideo.type.includes("mp4") ? "mp4" : "webm"}`,
      );
      session = await api(`/sessions/${session.sessionId}/video`, {
        method: "POST",
        body: form,
      });
      sessionId = session.sessionId;
      remember(sessionId);
    }
    status(
      "A captura fica salva no servidor. Você pode reabrir esta página para acompanhar.",
    );
    const deadline = Date.now() + 25 * 60 * 1000;
    let scheduled = false;
    while (current === generation) {
      session = await api(`/sessions/${sessionId}`);
      if (existingId && session.status === "done") {
        const savedUrl = `/sessions/${sessionId}/video?preview=true`;
        if (!$("capture-video").src.endsWith(savedUrl)) {
          $("capture-video").srcObject = null;
          $("capture-video").src = savedUrl;
          $("capture-video").controls = true;
          $("capture-empty").hidden = true;
          $("video-info").textContent =
            "Gravação salva nesta sessão · disponível para baixar";
        }
      }
      if (session.status === "error") throw new Error(session.error);
      if (session.status === "pending")
        throw new Error(
          "Esta sessão ainda não recebeu um vídeo. Importe a gravação novamente.",
        );
      if (session.status === "processing")
        job("Extraindo vistas da gravação salva…", null, "Preparando frames");
      else if (session.reconstructionStatus === "complete") {
        const result = await api(`/sessions/${sessionId}/world`);
        displayWorld(result, "Seu mundo reconstruído");
        job(
          "Mundo salvo. Você pode explorar e baixar o arquivo.",
          100,
          "Concluído",
        );
        status(
          "Reconstrução concluída. Explore o ambiente em órbita ou entre no mundo.",
        );
        break;
      } else if (
        session.reconstructionStatus === "none" ||
        (session.reconstructionStatus === "failed" && retry && !scheduled)
      ) {
        await api(`/sessions/${sessionId}/reconstruction`, { method: "POST" });
        scheduled = true;
      } else if (session.reconstructionStatus === "failed")
        throw new Error(session.reconstructionMessage);
      else {
        scheduled = true;
        job(
          session.reconstructionMessage || "Aguardando processamento…",
          session.reconstructionPercent,
          session.reconstructionStatus === "queued"
            ? "Na fila"
            : "Analisando vistas",
        );
      }
      if (Date.now() > deadline)
        throw new Error(
          "O acompanhamento atingiu o limite. Retome a captura salva para consultar o resultado.",
        );
      await delay(1500);
    }
  } catch (error) {
    status(
      error.message ||
        "Falha de conexão com o servidor. Retome a captura salva para acompanhar.",
      true,
    );
  } finally {
    busy = false;
    $("generate").innerHTML = sessionId
      ? "Retomar processamento <span>→</span>"
      : "Salvar e gerar mundo <span>→</span>";
    controls();
  }
}
$("generate").addEventListener("click", () => processCapture(undefined, true));

function displayWorld(value, title, { preserveView = false } = {}) {
  world = validateWorld(value);
  if (!viewer)
    throw new Error(
      "O arquivo está pronto, mas este navegador não conseguiu iniciar o 3D.",
    );
  viewer.setWorld(world, { preserveView });
  if (!world.preview) viewer.showGuideCamera(null);
  $("world-empty").hidden = true;
  $("world-title").textContent = title;
  $("world-count").textContent =
    `${(world.points.length / 7).toLocaleString("pt-BR")} BLOCOS`;
  for (const id of [
    "orbit",
    "free",
    "reset",
    "path",
    "export-world",
    "export-ply",
  ])
    $(id).disabled = false;
  if (!preserveView) $("path").checked = false;
  viewer.path.visible = $("path").checked;
  $("coverage").disabled = !world.confidence;
  if (!world.confidence) $("coverage").checked = false;
  viewer.setCoverage($("coverage").checked);
  $("coverage-legend").hidden = !world.confidence || !$("coverage").checked;
  $("world-details").hidden = false;
  $("metrics").replaceChildren();
  const metrics = world.metrics || {};
  for (const text of [
    `${metrics.registeredFrames ?? world.cameras.length} vistas registradas`,
    `${(world.points.length / 7).toLocaleString("pt-BR")} blocos`,
    "Escala relativa",
    ...(world.confidence
      ? [
          `${world.confidence.filter((c) => c >= 1).length.toLocaleString("pt-BR")} blocos com várias vistas`,
        ]
      : []),
  ]) {
    const item = document.createElement("span");
    item.textContent = text;
    $("metrics").append(item);
  }
  $("world-warning").textContent = Array.isArray(world.warnings)
    ? world.warnings.filter((x) => typeof x === "string").join(" ")
    : "Regiões não observadas ficam vazias.";
}
$("example").addEventListener("click", async () => {
  busy = true;
  controls();
  status("Abrindo exemplo reconstruído de uma cena sintética…");
  try {
    displayWorld(await api("/examples/room.json"), "Exemplo · sala sintética");
    status(
      "Exemplo reconstruído de 18 vistas sintéticas com deslocamento de câmera. Experimente entrar no mundo.",
    );
  } catch (error) {
    status(error.message, true);
  } finally {
    busy = false;
    controls();
  }
});
$("world-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  try {
    if (file) {
      if (file.size > 32 * 1024 * 1024)
        throw new Error("Mundo acima do limite de 32 MiB.");
      displayWorld(JSON.parse(await file.text()), "Mundo salvo");
      status("Mundo reaberto. Não é necessário processar o vídeo novamente.");
    }
  } catch (error) {
    status(
      error instanceof SyntaxError
        ? "O arquivo não contém JSON válido."
        : error.message,
      true,
    );
  }
  event.target.value = "";
});
$("orbit").onclick = () => viewer?.setMode("orbit");
$("free").onclick = () => {
  viewer?.setMode("free");
  $("world-canvas").focus();
};
$("reset").onclick = () => viewer?.reset();
$("path").onchange = () => {
  if (viewer?.path) viewer.path.visible = $("path").checked;
};
$("coverage").onchange = () => {
  viewer?.setCoverage($("coverage").checked);
  $("coverage-legend").hidden = !$("coverage").checked;
};
$("export-world").onclick = () => {
  if (world)
    download(
      new Blob([JSON.stringify(world)], { type: "application/json" }),
      "cliffly-mundo.json",
    );
};
$("export-ply").onclick = () => {
  if (world)
    download(
      new Blob([worldPly(world)], { type: "text/plain" }),
      "cliffly-pontos.ply",
    );
};
$("help-open").onclick = () => $("help").showModal();
$("help-close").onclick = () => $("help").close();
window.addEventListener("pagehide", () => {
  guide.stop({ beacon: true });
  ++generation;
  clearInterval(clock);
  releaseCamera();
});
showRecent();
const restore = new URL(location.href).searchParams.get("session");
if (restore && /^[a-f0-9-]{36}$/i.test(restore)) processCapture(restore);
