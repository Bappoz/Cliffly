import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MAX_BLOCKS } from './voxel.js';

export class WorldRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#18251f');
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 120);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0,0,-12);
    this.controls.enableDamping = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.controls.dampingFactor = 0.1;
    this.controls.minDistance = 2; this.controls.maxDistance = 40;
    this.controls.maxPolarAngle = Math.PI * 0.9;
    this.controls.zoomToCursor = true;
    this.lit = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.flat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1), this.lit, MAX_BLOCKS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0; this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    this.scene.add(new THREE.AmbientLight(0xffffff, 2.2));
    const light = new THREE.DirectionalLight(0xffffff, 1.5);light.position.set(-5,10,4);this.scene.add(light);
    const grid = new THREE.GridHelper(50,50,'#4d6450','#2b3d31');grid.position.set(0,-8,-12);this.scene.add(grid);
    this.grid = grid;
    this.object = new THREE.Object3D();this.color = new THREE.Color();
    this.observer = new ResizeObserver(() => this.resize());this.observer.observe(canvas.parentElement);
    this.reset();this.resize();
    canvas.addEventListener('keydown', e => {
      const direction={ArrowLeft:-1,ArrowRight:1,ArrowUp:-1,ArrowDown:1}[e.key];
      if(direction){e.preventDefault();const offset=this.camera.position.clone().sub(this.controls.target);offset.applyAxisAngle(e.key==='ArrowUp'||e.key==='ArrowDown'?new THREE.Vector3(1,0,0):new THREE.Vector3(0,1,0), direction*.08);this.camera.position.copy(this.controls.target).add(offset);this.controls.update();}
      if(e.key==='Home'){e.preventDefault();this.reset();}
      if(e.key==='+'||e.key==='-'||e.key==='='){e.preventDefault();this.camera.position.sub(this.controls.target).multiplyScalar(e.key==='-'?1.1:.9).add(this.controls.target);this.controls.update();}
    });
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => { this.lost = false; });
  }
  update(scene) {
    this.current = scene;this.camera.fov = scene.fov;
    this.resize();
    const points=scene.points;
    this.mesh.count = points.length/7;
    for(let i=0;i<this.mesh.count;i++){
      const p=i*7;this.object.position.set(points[p],points[p+1],points[p+2]);this.object.scale.setScalar(points[p+3]);this.object.updateMatrix();
      this.mesh.setMatrixAt(i,this.object.matrix);
      this.color.setRGB(points[p+4]/255,points[p+5]/255,points[p+6]/255,THREE.SRGBColorSpace);this.mesh.setColorAt(i,this.color);
    }
    this.mesh.instanceMatrix.needsUpdate=true;if(this.mesh.instanceColor)this.mesh.instanceColor.needsUpdate=true;
  }
  resize(){
    const w=this.canvas.parentElement.clientWidth,h=this.canvas.parentElement.clientHeight;
    if(!w||!h)return;
    const aspect=this.current?this.current.width/this.current.height:4/3;
    if(this.lastWidth===w&&this.lastHeight===h&&this.lastAspect===aspect&&this.lastFov===(this.current?.fov??55))return;
    this.lastWidth=w;this.lastHeight=h;this.lastAspect=aspect;this.lastFov=this.current?.fov??55;
    this.renderer.setSize(w,h,false);
    const sourceAspect=this.current?this.current.width/this.current.height:4/3;
    // Fit the capture vertically and horizontally rather than cropping its sides.
    this.camera.aspect=w/h;
    const vertical=this.current?.fov??55;
    this.camera.fov=this.camera.aspect<sourceAspect?THREE.MathUtils.radToDeg(2*Math.atan(Math.tan(THREE.MathUtils.degToRad(vertical/2))*sourceAspect/this.camera.aspect)):vertical;
    this.camera.updateProjectionMatrix();
  }
  reset(){this.camera.position.set(0,0,0);this.controls.target.set(0,0,-12);this.controls.update();}
  compare(enabled){this.mesh.material=enabled?this.flat:this.lit;this.scene.background.set(enabled?'#dedccf':'#18251f');this.grid.visible=!enabled;}
  render(){if(!this.lost){this.controls.update();this.renderer.render(this.scene,this.camera);}}
  dispose(){this.observer.disconnect();this.controls.dispose();this.mesh.geometry.dispose();this.lit.dispose();this.flat.dispose();this.renderer.dispose();}
}
