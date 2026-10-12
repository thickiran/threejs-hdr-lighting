// Before/after demo for the threejs-hdr-lighting skill.
// "Typical" = the settings agents usually ship. "With skill" = the same scene, then the
// skill's helpers applied on top (setupRenderer, tameLights, createComposer,
// createShadowFollower, createLightFlicker, calibrateExposure).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  setupRenderer, createComposer, tameLights, measureFrame, calibrateExposure,
  createShadowFollower, createLightFlicker,
} from './hdr-lighting.js';

export function mountDemo({ canvas, onStats, onReport }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.shadowMap.enabled = true;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 300);
  let state = null;
  let mode = 'typical';
  let lastStats = -1;
  const t0 = performance.now();
  const now = () => (performance.now() - t0) / 1000;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  function size() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (state?.composer) {
      state.composer.setPixelRatio(renderer.getPixelRatio());
      state.composer.setSize(w, h);
    }
  }

  function buildScene() {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a2430);
    scene.fog = new THREE.Fog(0x1a2430, 45, 110);
    scene.environment = envTex;          // agents love RoomEnvironment at full strength
    scene.environmentIntensity = 0.8;

    // --- The lights an agent typically writes ---
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x553f2a, 0.8));
    const sun = new THREE.DirectionalLight(0xffe2b8, 2.5);
    sun.position.set(14, 18, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 1, far: 70 });
    sun.shadow.camera.updateProjectionMatrix();
    scene.add(sun, sun.target);
    const fill = new THREE.DirectionalLight(0xffffff, 1.0);
    fill.position.set(-10, 8, -6);
    scene.add(fill);

    // ground + track
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), new THREE.MeshStandardMaterial({ color: 0x6f7b62, roughness: 0.95 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    const track = new THREE.Mesh(new THREE.RingGeometry(9, 13, 96), new THREE.MeshStandardMaterial({ color: 0x3b3f45, roughness: 0.85 }));
    track.rotation.x = -Math.PI / 2;
    track.position.y = 0.01;
    track.receiveShadow = true;
    scene.add(track);

    // white buildings (where clipping is most visible)
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xf2efe8, roughness: 0.8, name: 'whitewall' });
    const blocks = [[-18, 4, -6, 6, 8, 5], [-16, 3, 8, 5, 6, 6], [18, 5, -4, 5, 10, 6], [17, 2.5, 10, 7, 5, 5], [2, 3, -20, 10, 6, 4]];
    for (const [x, y, z, w, h, d] of blocks) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
      b.position.set(x, y, z);
      b.castShadow = b.receiveShadow = true;
      scene.add(b);
    }

    // chrome fuel tank + glossy spheres (specular fireflies)
    const chrome = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.02, name: 'chrome' });
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 4, 48), chrome);
    tank.position.set(0, 2, 0);
    tank.castShadow = true;
    scene.add(tank);
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.7, 48, 24), chrome);
      s.position.set(-2.4 + i * 2.4, 0.7, 4);
      s.castShadow = true;
      scene.add(s);
    }

    // neon sign
    const neon = new THREE.Mesh(new THREE.BoxGeometry(5, 0.35, 0.2), new THREE.MeshStandardMaterial({ color: 0x220011, emissive: 0xff2d7a, emissiveIntensity: 6, name: 'neon' }));
    neon.position.set(-18, 7, -3.4);
    scene.add(neon);

    // street lamps: decay 0, random flicker
    const lamps = [];
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 4.2, 8), new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.6 }));
      pole.position.set(Math.cos(a) * 14.5, 2.1, Math.sin(a) * 14.5);
      pole.castShadow = true;
      scene.add(pole);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 8), new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xffd08a, emissiveIntensity: 5, name: 'bulb' }));
      bulb.position.set(pole.position.x, 4.3, pole.position.z);
      scene.add(bulb);
      const lamp = new THREE.PointLight(0xffc27a, 2.5, 0, 0);
      lamp.position.copy(bulb.position);
      scene.add(lamp);
      lamps.push(lamp);
    }

    // the "moto"
    const bike = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 0.45), new THREE.MeshStandardMaterial({ color: 0xd8342c, metalness: 0.9, roughness: 0.05, name: 'paint' }));
    body.position.y = 0.75;
    const rider = new THREE.Mesh(new THREE.CapsuleGeometry(0.25, 0.6, 4, 8), new THREE.MeshStandardMaterial({ color: 0x1d2b38, roughness: 0.7 }));
    rider.position.set(-0.1, 1.35, 0);
    const wheelGeo = new THREE.TorusGeometry(0.38, 0.12, 10, 24);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.6 });
    const w1 = new THREE.Mesh(wheelGeo, wheelMat); w1.position.set(0.7, 0.5, 0);
    const w2 = w1.clone(); w2.position.x = -0.7;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveIntensity: 8, name: 'headlight' }));
    head.position.set(0.85, 0.9, 0);
    bike.add(body, rider, w1, w2, head);
    bike.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    scene.add(bike);

    return { scene, sun, lamps, bike, chrome };
  }

  function setMode(next) {
    mode = next;
    if (state) {
      state.composer.dispose?.();
      state.scene.traverse((o) => { o.geometry?.dispose(); [].concat(o.material || []).forEach((m) => m.dispose()); });
    }
    const s = buildScene();
    const offset = new THREE.Vector3(14, 18, 6);
    let composer, follow, flickers = [], report = [];

    if (mode === 'typical') {
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.toneMappingExposure = 1;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      composer = new EffectComposer(renderer); // no MSAA
      composer.addPass(new RenderPass(s.scene, camera));
      composer.addPass(new UnrealBloomPass(new THREE.Vector2(512, 512), 0.6, 0.5, 0.6));
      composer.addPass(new OutputPass());
      follow = (p) => { s.sun.position.copy(p).add(offset); s.sun.target.position.copy(p); };
      flickers = s.lamps.map((l, i) => () => { if (i === 1) l.intensity = 2.5 * (0.4 + Math.random() * 0.9); });
    } else {
      setupRenderer(renderer, { exposure: 0.9 });
      report = tameLights(s.scene);
      s.sun.shadow.mapSize.set(2048, 2048);
      s.sun.shadow.radius = 3;
      const post = createComposer(renderer, s.scene, camera, { bloom: { strength: 0.35, radius: 0.4, threshold: 1.0 } });
      composer = post.composer;
      follow = createShadowFollower(s.sun, offset);
      const f = createLightFlicker(s.lamps[1], { amount: 0.08, speed: 2 });
      flickers = [(t) => f(t)];
    }
    state = { ...s, composer, follow, flickers };
    size();
    onReport?.(mode, report);
    if (mode === 'skill') {
      calibrateExposure(renderer, () => renderFrame(now()));
    }
  }

  const tmp = new THREE.Vector3();
  function renderFrame(t) {
    const a = t * 0.35;
    const r = 11;
    state.bike.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    state.bike.rotation.y = -a - Math.PI / 2;
    state.follow(state.bike.position);
    state.flickers.forEach((f) => f(t));
    // slow orbiting camera so aliasing and shadow swimming are visible
    const ca = t * 0.08 + 0.6;
    camera.position.set(Math.cos(ca) * 30, 13 + Math.sin(t * 0.2) * 1.5, Math.sin(ca) * 30);
    camera.lookAt(tmp.set(0, 1.5, 0));
    state.composer.render();
  }

  // Luma histogram of the displayed frame (demo-only; the skill uses measureFrame).
  function histogram(bins = 48, step = 6) {
    const gl = renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const out = new Array(bins).fill(0);
    let n = 0;
    for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      const l = (0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2]) / 255;
      out[Math.min(bins - 1, Math.floor(l * bins))]++; n++;
    }
    return out.map((c) => c / n);
  }

  function stats() {
    const m = measureFrame(renderer, { step: 6 });
    return { ...m, hist: histogram(), exposure: renderer.toneMappingExposure, toneMapping: renderer.toneMapping };
  }

  setMode('typical');
  addEventListener('resize', size);
  new ResizeObserver(size).observe(canvas);

  let paused = false;
  renderer.setAnimationLoop(() => {
    if (paused) return;
    const t = now();
    renderFrame(t);
    if (t - lastStats > 0.4) { lastStats = t; onStats?.(stats(), mode); }
  });

  return {
    setMode,
    get mode() { return mode; },
    pause(v) { paused = v; },
    renderer,
  };
}
