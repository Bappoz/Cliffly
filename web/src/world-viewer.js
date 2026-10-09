import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { MAX_WORLD_BLOCKS } from "./world-file.js";

export class WorldViewer {
  constructor(canvas, onMode) {
    this.canvas = canvas;
    this.onMode = onMode;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color("#132522");
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.02, 2000);
    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.enableDamping = true;
    this.orbit.maxDistance = 1000;
    this.orbit.minDistance = 0.05;
    this.walk = new PointerLockControls(this.camera, canvas);
    this.material = new THREE.MeshLambertMaterial();
    this.mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(),
      this.material,
      MAX_WORLD_BLOCKS,
    );
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh, new THREE.AmbientLight(0xffffff, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.3);
    sun.position.set(10, 30, 20);
    this.scene.add(sun);
    this.keys = new Set();
    this.mode = "orbit";
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas.parentElement);
    this.onKeyDown = (event) => {
      if (document.activeElement !== canvas && !this.walk.isLocked) return;
      if (
        [
          "KeyW",
          "KeyA",
          "KeyS",
          "KeyD",
          "KeyQ",
          "KeyE",
          "Space",
          "ShiftLeft",
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown",
        ].includes(event.code)
      ) {
        event.preventDefault();
        this.keys.add(event.code);
      }
      if (event.code === "Home") {
        event.preventDefault();
        this.reset();
      }
    };
    this.onKeyUp = (event) => this.keys.delete(event.code);
    this.onBlur = () => this.keys.clear();
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    canvas.addEventListener("blur", this.onBlur);
    document.addEventListener("visibilitychange", this.onBlur);
    this.walk.addEventListener("unlock", this.onBlur);
    canvas.addEventListener("click", () => {
      if (this.mode === "free" && this.world && !this.walk.isLocked) {
        try {
          this.walk.lock();
        } catch {
          /* Keyboard navigation remains available. */
        }
      }
    });
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.lost = true;
    });
    canvas.addEventListener("webglcontextrestored", () => {
      this.lost = false;
    });
    this.camera.position.set(20, 15, 20);
    this.orbit.target.set(0, 0, 0);
    this.resize();
    this.last = performance.now();
  }
  setWorld(world) {
    this.world = world;
    const box = new THREE.Box3();
    const object = new THREE.Object3D(),
      color = new THREE.Color();
    this.mesh.count = world.points.length / 7;
    for (let i = 0; i < this.mesh.count; i++) {
      const p = i * 7;
      object.position.fromArray(world.points, p);
      object.scale.setScalar(world.points[p + 3] * 0.98);
      object.updateMatrix();
      box.expandByPoint(object.position);
      this.mesh.setMatrixAt(i, object.matrix);
      color.setRGB(
        world.points[p + 4] / 255,
        world.points[p + 5] / 255,
        world.points[p + 6] / 255,
        THREE.SRGBColorSpace,
      );
      this.mesh.setColorAt(i, color);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
    this.center = box.getCenter(new THREE.Vector3());
    this.radius = Math.max(1, box.getSize(new THREE.Vector3()).length() / 2);
    this.speed = this.radius / 5;
    if (this.path) {
      this.scene.remove(this.path);
      this.path.geometry.dispose();
      this.path.material.dispose();
    }
    const path = world.cameras.map((c) => new THREE.Vector3(...c.position));
    this.path = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(path),
      new THREE.LineBasicMaterial({ color: "#f3d484" }),
    );
    this.scene.add(this.path);
    this.path.visible = false;
    this.setMode("orbit");
    this.reset();
  }
  setMode(mode) {
    this.walk.unlock();
    this.keys.clear();
    this.mode = mode;
    this.orbit.enabled = mode === "orbit";
    if (mode === "free") this.reset();
    else if (this.world) this.orbit.target.copy(this.center);
    this.onMode?.(mode);
  }
  reset() {
    if (!this.world) return;
    if (this.mode === "free" && this.world.cameras.length) {
      const start = this.world.cameras[0];
      this.camera.position.fromArray(start.position);
      this.camera.lookAt(new THREE.Vector3(...start.target));
    } else {
      this.orbit.target.copy(this.center);
      this.camera.position
        .copy(this.center)
        .add(
          new THREE.Vector3(0.65, 0.45, 1).multiplyScalar(this.radius * 1.8),
        );
      this.camera.lookAt(this.center);
      this.orbit.update();
    }
  }
  resize() {
    const { clientWidth: w, clientHeight: h } = this.canvas.parentElement;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
  render(now = performance.now()) {
    const dt = Math.min((now - this.last) / 1000, 0.05);
    this.last = now;
    if (this.mode === "free" && this.world) {
      const speed = this.speed * dt * (this.keys.has("ShiftLeft") ? 3 : 1);
      const horizontal =
        Number(this.keys.has("KeyD")) - Number(this.keys.has("KeyA"));
      const forward =
        Number(this.keys.has("KeyW") || this.keys.has("ArrowUp")) -
        Number(this.keys.has("KeyS") || this.keys.has("ArrowDown"));
      const norm = Math.max(1, Math.hypot(horizontal, forward));
      this.walk.moveRight((horizontal * speed) / norm);
      this.walk.moveForward((forward * speed) / norm);
      this.camera.position.y +=
        (Number(this.keys.has("KeyE") || this.keys.has("Space")) -
          Number(this.keys.has("KeyQ"))) *
        speed;
      const turn =
        Number(this.keys.has("ArrowLeft")) -
        Number(this.keys.has("ArrowRight"));
      if (turn) {
        const e = new THREE.Euler().setFromQuaternion(
          this.camera.quaternion,
          "YXZ",
        );
        e.y += turn * dt;
        this.camera.quaternion.setFromEuler(e);
      }
    } else this.orbit.update();
    if (!this.lost) this.renderer.render(this.scene, this.camera);
  }
  dispose() {
    this.walk.unlock();
    this.walk.dispose();
    this.orbit.dispose();
    this.observer.disconnect();
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    document.removeEventListener("visibilitychange", this.onBlur);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.path?.geometry.dispose();
    this.path?.material.dispose();
    this.renderer.dispose();
  }
}
