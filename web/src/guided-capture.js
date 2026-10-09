// The complete recording is independent of these sampled preview frames.
export class GuidedCapture {
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.canvas = document.createElement("canvas");
    this.context = this.canvas.getContext("2d");
    this.generation = 0;
  }
  async request(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      const value = await response.json().catch(() => ({}));
      throw new Error(
        value.error ||
          "Não foi possível acompanhar a prévia. A gravação continua.",
      );
    }
    return response.json();
  }
  async start(video) {
    const token = ++this.generation;
    this.revision = 0;
    try {
      const scan = await this.request("/scans", { method: "POST" });
      if (token !== this.generation) {
        await this.end(scan.scanId);
        return;
      }
      this.id = scan.scanId;
      this.video = video;
      this.callbacks.started?.(scan);
      await this.sample(token);
    } catch (error) {
      if (token === this.generation) {
        this.callbacks.error?.(error.message);
        await this.stop();
      }
    }
  }
  async sample(token) {
    if (token !== this.generation) return;
    const start = performance.now();
    try {
      const video = this.video;
      if (!video.videoWidth || video.readyState < 2) {
        this.timer = setTimeout(() => this.sample(token), 250);
        return;
      }
      this.canvas.width = Math.min(640, video.videoWidth);
      this.canvas.height = Math.round(
        (video.videoHeight * this.canvas.width) / video.videoWidth,
      );
      this.context.drawImage(
        video,
        0,
        0,
        this.canvas.width,
        this.canvas.height,
      );
      const jpeg = await new Promise((resolve) =>
        this.canvas.toBlob(resolve, "image/jpeg", 0.86),
      );
      if (token !== this.generation) return;
      if (!jpeg)
        throw new Error("Não foi possível ler a câmera para a prévia.");
      const result = await this.request(`/scans/${this.id}/frames`, {
        method: "POST",
        headers: { "Content-Type": "image/jpeg" },
        body: jpeg,
      });
      if (token !== this.generation) return;
      if (result.status !== "active")
        throw new Error(
          result.error || "Prévia encerrada. A gravação continua.",
        );
      this.callbacks.state?.(result.preview);
      if (result.preview.revision > this.revision) {
        const world = await this.request(`/scans/${this.id}/world`);
        if (token !== this.generation) return;
        this.revision = result.preview.revision;
        this.callbacks.world?.(world);
      }
      // One request at a time. Slow reconstruction reduces sampling, never queues frames.
      this.timer = setTimeout(
        () => this.sample(token),
        Math.max(100, 1000 - (performance.now() - start)),
      );
    } catch (error) {
      if (token === this.generation) {
        this.callbacks.error?.(error.message);
        await this.stop();
      }
    }
  }
  async end(id, beacon = false) {
    const path = `/scans/${id}/stop`;
    if (beacon && navigator.sendBeacon?.(path, "")) return;
    try {
      await this.request(path, { method: "POST" });
    } catch {
      /* Server idle timeout is the final cleanup. */
    }
  }
  async stop({ beacon = false } = {}) {
    ++this.generation;
    clearTimeout(this.timer);
    const id = this.id;
    this.id = null;
    if (id) await this.end(id, beacon);
    this.callbacks.stopped?.();
  }
}
