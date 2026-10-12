/**
 * hdr-lighting.js — drop-in exposure discipline for three.js (r155+ physical lights)
 *
 * Fixes the two things agent-built three.js scenes almost always get wrong:
 *   1. Blown-out lights: no tone mapping (NoToneMapping is the WebGLRenderer default),
 *      stacked ambient + hemisphere + directional lights, decay-0 point lights,
 *      emissive values that bloom at threshold 0.
 *   2. Flicker: shadow acne, shadow maps that "swim" when the shadow camera follows
 *      the player, specular fireflies on glossy metal amplified by bloom, aliased edges
 *      because EffectComposer silently drops the renderer's MSAA, and Math.random()
 *      light "flicker" effects.
 *
 * Usage (plain three.js):
 *
 *   import { setupRenderer, createComposer, tameLights, auditLighting,
 *            calibrateExposure, createShadowFollower } from './hdr-lighting.js';
 *
 *   setupRenderer(renderer);                       // ACES + exposure + sRGB + soft shadows
 *   const post = createComposer(renderer, scene, camera);   // MSAA HDR target → bloom → OutputPass
 *   tameLights(scene);                             // retrofit: fixes budgets, decay, bias, fireflies
 *   window.addEventListener('resize', () => post.setSize(innerWidth, innerHeight));
 *   renderer.setAnimationLoop(() => post.render());
 *   await calibrateExposure(renderer, () => post.render());   // optional one-shot auto exposure
 *   auditLighting(scene, renderer, post.composer);           // prints anything still wrong
 *
 * Import map (single-file artifacts):
 *   { "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js",
 *                  "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/" } }
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/* ------------------------------------------------------------------ *
 * 1. Renderer: ACES filmic tone mapping + sane exposure
 * ------------------------------------------------------------------ */

const TONE_MAPPERS = {
  aces: THREE.ACESFilmicToneMapping,
  agx: THREE.AgXToneMapping,
  neutral: THREE.NeutralToneMapping,
};

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {{exposure?: number, toneMapping?: 'aces'|'agx'|'neutral', maxPixelRatio?: number}} [opts]
 */
export function setupRenderer(renderer, opts = {}) {
  const { exposure = 0.9, toneMapping = 'aces', maxPixelRatio = 2 } = opts;
  renderer.toneMapping = TONE_MAPPERS[toneMapping] ?? THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = exposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, maxPixelRatio));
  if (renderer.shadowMap.enabled) {
    // PCFSoftShadowMap was removed in recent three.js; PCF + shadow.radius is the soft path.
    renderer.shadowMap.type = THREE.PCFShadowMap;
  }
  return renderer;
}

/* ------------------------------------------------------------------ *
 * 2. Post-processing: MSAA half-float target → (bloom) → OutputPass
 *    OutputPass is where ACES + exposure + sRGB get applied when a
 *    composer is used. Without it the scene is never tone mapped.
 * ------------------------------------------------------------------ */

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @param {THREE.Camera} camera
 * @param {{bloom?: false|{strength?: number, radius?: number, threshold?: number}, samples?: number}} [opts]
 */
export function createComposer(renderer, scene, camera, opts = {}) {
  const { samples = 4 } = opts;
  const bloomOpts = opts.bloom === false ? null : { strength: 0.35, radius: 0.4, threshold: 1.0, ...(opts.bloom || {}) };

  const css = renderer.getSize(new THREE.Vector2());
  const px = renderer.getPixelRatio();
  // EffectComposer's default target has NO multisampling, which silently undoes
  // `antialias: true` and makes bright edges crawl. Give it an MSAA HDR target.
  const target = new THREE.WebGLRenderTarget(css.x * px, css.y * px, {
    type: THREE.HalfFloatType,
    samples,
  });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));

  let bloomPass = null;
  if (bloomOpts) {
    bloomPass = new UnrealBloomPass(new THREE.Vector2(css.x, css.y), bloomOpts.strength, bloomOpts.radius, bloomOpts.threshold);
    composer.addPass(bloomPass);
  }
  const outputPass = new OutputPass(); // ACES + toneMappingExposure + sRGB, read from the renderer
  composer.addPass(outputPass);

  function setSize(width, height) {
    renderer.setSize(width, height);
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(width, height);
    if (camera.isPerspectiveCamera) {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
  }
  // A custom target makes EffectComposer think its size is in device pixels; normalise now.
  composer.setPixelRatio(px);
  composer.setSize(css.x, css.y);

  return { composer, bloomPass, outputPass, setSize, render: (dt) => composer.render(dt) };
}

/* ------------------------------------------------------------------ *
 * 3. Light rig presets for NEW scenes (meters, physical lights, ACES)
 * ------------------------------------------------------------------ */

export const RIG_PRESETS = {
  //            sun   hemi  env   exposure
  daylight:  { sun: 2.6, hemi: 0.55, env: 0.35, exposure: 0.9 },
  overcast:  { sun: 1.0, hemi: 1.1,  env: 0.5,  exposure: 1.0 },
  golden:    { sun: 2.0, hemi: 0.35, env: 0.25, exposure: 0.95, sunColor: 0xffc58a },
  studio:    { sun: 1.6, hemi: 0.25, env: 0.8,  exposure: 1.0 },
  night:     { sun: 0.3, hemi: 0.12, env: 0.08, exposure: 1.1, sunColor: 0x9db4ff },
};

/**
 * One key light + one soft fill. No AmbientLight: it flattens everything and is the most
 * common source of the washed-out look. Returns the lights so callers can tweak them.
 */
export function createLightRig(scene, preset = 'daylight', { shadows = true, shadowSize = 30, mapSize = 2048 } = {}) {
  const p = typeof preset === 'string' ? RIG_PRESETS[preset] : preset;
  const hemi = new THREE.HemisphereLight(0xdfeaff, 0x4a4136, p.hemi);
  const sun = new THREE.DirectionalLight(p.sunColor ?? 0xfff3e2, p.sun);
  sun.position.set(12, 20, 8);
  scene.add(hemi, sun, sun.target);
  if (shadows) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(mapSize, mapSize);
    const s = shadowSize / 2;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 0.5, far: 80 });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    sun.shadow.radius = 3;
  }
  if (scene.environment) scene.environmentIntensity = p.env;
  return { sun, hemi, preset: p };
}

/* ------------------------------------------------------------------ *
 * 4. Retrofit: tame an existing scene's lights and materials
 * ------------------------------------------------------------------ */

/**
 * Walks the scene and fixes the usual overexposure / flicker sources in place.
 * Returns a report of everything it changed.
 *
 * Global budget heuristic: under ACES at exposure ~0.9, the summed intensity of
 * ambient + hemisphere + directional lights should land around 3–3.5 (white
 * surface facing the key ≈ 1.0 linear before tone mapping), minus whatever the
 * environment map contributes. Above that, everything is scaled down together so
 * the artist's ratios survive.
 */
export function tameLights(scene, opts = {}) {
  const {
    budget = 3.4,             // ambient + hemi + directional, before env compensation
    envWeight = 1.5,          // how much budget 1.0 environmentIntensity consumes
    maxAmbient = 0.25,
    maxEnvironmentIntensity = 0.35, // RoomEnvironment at 1.0 is a full studio on its own
    fixDecay = true,
    refDistance = null,       // typical light→surface distance for decay compensation; auto if null
    maxPointIntensity = null, // candela cap for point/spot; auto from refDistance if null
    roughnessFloor = 0.22,    // glossy metal under strong lights = fireflies
    maxEmissiveIntensity = 2.5,
    maxShadowCasters = 2,
    shadowBias = -0.0004,
    shadowNormalBias = 0.03,
  } = opts;

  const report = [];
  const lights = [];
  scene.traverse((o) => o.isLight && lights.push(o));

  // Reference distance for point/spot falloff: by default each light's height above the
  // lowest geometry (a lamp lights the floor beneath it). Override with `refDistance`.
  const box = new THREE.Box3().setFromObject(scene);
  const floorY = box.isEmpty() ? 0 : box.min.y;
  const wp = new THREE.Vector3();
  const distFor = (l) => refDistance ?? THREE.MathUtils.clamp(l.getWorldPosition(wp).y - floorY, 1, 25);

  // 4a. Ambient clamp
  for (const l of lights) {
    if (l.isAmbientLight && l.intensity > maxAmbient) {
      report.push(`AmbientLight ${l.intensity.toFixed(2)} → ${maxAmbient} (ambient flattens and washes out)`);
      l.intensity = maxAmbient;
    }
  }

  // 4a'. Environment map strength
  if (scene.environment && (scene.environmentIntensity ?? 1) > maxEnvironmentIntensity) {
    report.push(`scene.environmentIntensity ${(scene.environmentIntensity ?? 1).toFixed(2)} → ${maxEnvironmentIntensity} (env lighting stacks on top of every light)`);
    scene.environmentIntensity = maxEnvironmentIntensity;
  }

  // 4b. Global budget on non-falloff lights
  const globalLights = lights.filter((l) => l.isAmbientLight || l.isHemisphereLight || l.isDirectionalLight);
  const env = scene.environment ? (scene.environmentIntensity ?? 1) : 0;
  const allowed = Math.max(1.2, budget - envWeight * env);
  const total = globalLights.reduce((s, l) => s + l.intensity, 0);
  if (total > allowed) {
    const k = allowed / total;
    for (const l of globalLights) l.intensity *= k;
    report.push(`Global light sum ${total.toFixed(2)} > budget ${allowed.toFixed(2)} → scaled all ambient/hemi/directional by ×${k.toFixed(2)}`);
  }

  // 4c. Point / spot lights: physical decay and an intensity cap
  for (const l of lights) {
    if (!(l.isPointLight || l.isSpotLight)) continue;
    const dRef = distFor(l);
    const pointCap = maxPointIntensity ?? 4 * dRef * dRef; // ≈ irradiance 4 at the reference distance
    if (fixDecay && l.decay < 2) {
      const before = l.intensity;
      // decay 0 means "same brightness at any distance": compensate so it matches at dRef
      l.intensity = before * Math.pow(dRef, 2 - l.decay);
      l.decay = 2;
      report.push(`${l.type} decay → 2 (intensity ${before.toFixed(2)} → ${l.intensity.toFixed(1)} to match at ${dRef.toFixed(1)}m)`);
    }
    if (l.intensity > pointCap) {
      report.push(`${l.type} intensity ${l.intensity.toFixed(1)} → ${pointCap.toFixed(1)} (cap for ${dRef.toFixed(1)}m scene scale)`);
      l.intensity = pointCap;
    }
  }

  // 4d. Shadows: bias against acne, limit shadow casters
  const casters = lights.filter((l) => l.castShadow);
  casters.forEach((l, i) => {
    if (i >= maxShadowCasters) {
      l.castShadow = false;
      report.push(`${l.type} castShadow → false (more than ${maxShadowCasters} shadow casters costs a lot and flickers on mobile)`);
      return;
    }
    if (l.shadow.bias === 0) { l.shadow.bias = shadowBias; report.push(`${l.type} shadow.bias → ${shadowBias} (shadow acne)`); }
    if (l.shadow.normalBias === 0) { l.shadow.normalBias = shadowNormalBias; report.push(`${l.type} shadow.normalBias → ${shadowNormalBias}`); }
  });

  // 4e. Materials: firefly control + emissive cap + texture colour spaces
  const seen = new Set();
  scene.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      if (m.isMeshStandardMaterial) {
        if (m.metalness > 0.5 && m.roughness < roughnessFloor && !m.roughnessMap) {
          report.push(`${m.name || m.type} roughness ${m.roughness.toFixed(2)} → ${roughnessFloor} (specular fireflies)`);
          m.roughness = roughnessFloor;
        }
        if (m.emissiveIntensity > maxEmissiveIntensity) {
          report.push(`${m.name || m.type} emissiveIntensity ${m.emissiveIntensity} → ${maxEmissiveIntensity}`);
          m.emissiveIntensity = maxEmissiveIntensity;
        }
      }
      for (const key of ['map', 'emissiveMap']) {
        const t = m[key];
        if (t && t.colorSpace !== THREE.SRGBColorSpace) {
          t.colorSpace = THREE.SRGBColorSpace;
          t.needsUpdate = true;
          report.push(`${m.name || m.type}.${key}.colorSpace → SRGB (colour textures read as linear look washed out)`);
        }
      }
    }
  });

  // collapse identical lines ("… ×4")
  const counts = new Map();
  for (const r of report) counts.set(r, (counts.get(r) || 0) + 1);
  const out = [...counts].map(([r, n]) => (n > 1 ? `${r}  ×${n}` : r));
  if (out.length) console.info('[hdr-lighting] tameLights changes:\n  ' + out.join('\n  '));
  return out;
}

/* ------------------------------------------------------------------ *
 * 5. Measure the final frame: how much of the image is clipped?
 * ------------------------------------------------------------------ */

/**
 * Reads back the frame that was just drawn (call it right after render, in the same task)
 * and returns { mean, clipped, crushed } in 0..1. `clipped` = share of pixels with any
 * channel ≥ 250/255. Targets: clipped < 0.02, mean 0.30–0.55 for a normal scene.
 */
export function measureFrame(renderer, { step = 4 } = {}) {
  const gl = renderer.getContext();
  renderer.setRenderTarget(null);
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  let n = 0, sum = 0, clip = 0, crush = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      const r = buf[i], g = buf[i + 1], b = buf[i + 2];
      const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      sum += l; n++;
      if (r >= 250 || g >= 250 || b >= 250) clip++;
      if (l < 0.02) crush++;
    }
  }
  return { mean: sum / n, clipped: clip / n, crushed: crush / n };
}

/**
 * One-shot auto exposure. Renders a few frames, measures, and nudges
 * renderer.toneMappingExposure until clipping is under `maxClipped` and the mean
 * brightness sits inside [minMean, maxMean]. It only corrects what is actually wrong:
 * a correctly exposed bright daylight scene is left alone.
 * Not continuous on purpose (continuous auto-exposure "pumps").
 */
export async function calibrateExposure(renderer, renderFrame, opts = {}) {
  const { maxClipped = 0.015, minMean = 0.25, maxMean = 0.62, min = 0.3, max = 1.6, iterations = 12 } = opts;
  let stats;
  const start = renderer.toneMappingExposure;
  for (let i = 0; i < iterations; i++) {
    await new Promise((r) => requestAnimationFrame(r));
    renderFrame();
    stats = measureFrame(renderer); // same task as the render, so the drawing buffer is intact
    let e = renderer.toneMappingExposure;
    if (stats.clipped > maxClipped) e *= 0.85;
    else if (stats.mean > maxMean) e *= 0.93;
    else if (stats.mean < minMean) e *= 1.12;
    else break;
    const next = THREE.MathUtils.clamp(e, min, max);
    if (next === renderer.toneMappingExposure) break;
    renderer.toneMappingExposure = next;
  }
  console.info(`[hdr-lighting] exposure ${start.toFixed(2)} → ${renderer.toneMappingExposure.toFixed(2)} · mean ${stats.mean.toFixed(2)} · clipped ${(stats.clipped * 100).toFixed(1)}%`);
  return { exposure: renderer.toneMappingExposure, ...stats };
}

/* ------------------------------------------------------------------ *
 * 6. Flicker-free helpers
 * ------------------------------------------------------------------ */

/**
 * Directional-light shadows that follow a moving target (player, vehicle) without
 * shimmering: the shadow camera is snapped to whole shadow-map texels in light space,
 * so the shadow map content never sub-texel slides.
 *
 *   const follow = createShadowFollower(sun, new THREE.Vector3(12, 20, 8));
 *   // each frame:  follow(player.position);
 */
export function createShadowFollower(light, offset) {
  const off = offset ? offset.clone() : light.position.clone().sub(light.target.position);
  const up = Math.abs(off.clone().normalize().y) > 0.99 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  const basis = new THREE.Matrix4().lookAt(off, new THREE.Vector3(), up);
  const ax = new THREE.Vector3(), ay = new THREE.Vector3(), az = new THREE.Vector3();
  basis.extractBasis(ax, ay, az);
  const cam = light.shadow.camera;
  const snapped = new THREE.Vector3();
  if (!light.target.parent && light.parent) light.parent.add(light.target);

  return function follow(focus) {
    const tx = (cam.right - cam.left) / light.shadow.mapSize.x;
    const ty = (cam.top - cam.bottom) / light.shadow.mapSize.y;
    const x = Math.round(focus.dot(ax) / tx) * tx;
    const y = Math.round(focus.dot(ay) / ty) * ty;
    const z = focus.dot(az);
    snapped.set(0, 0, 0).addScaledVector(ax, x).addScaledVector(ay, y).addScaledVector(az, z);
    light.target.position.copy(snapped);
    light.position.copy(snapped).add(off);
    light.target.updateMatrixWorld();
  };
}

/**
 * Candle / neon / fire flicker that reads as flicker and not as a strobe:
 * smooth value noise, ±amount around the base intensity, never Math.random() per frame.
 *
 *   const flick = createLightFlicker(lamp, { amount: 0.08, speed: 2 });
 *   // each frame:  flick(clock.elapsedTime);
 */
export function createLightFlicker(light, { amount = 0.08, speed = 1.5, seed = Math.random() * 100 } = {}) {
  const base = light.intensity;
  const hash = (n) => { const s = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453; return s - Math.floor(s); };
  const noise = (t) => { const i = Math.floor(t), f = t - i, u = f * f * (3 - 2 * f); return hash(i) * (1 - u) + hash(i + 1) * u; };
  return function update(time) {
    const n = noise(time * speed) * 0.7 + noise(time * speed * 2.3 + 17) * 0.3; // 0..1
    light.intensity = base * (1 + amount * (n * 2 - 1));
  };
}

/* ------------------------------------------------------------------ *
 * 7. Audit: print everything that is still likely to blow out or flicker
 * ------------------------------------------------------------------ */

export function auditLighting(scene, renderer, composer = null) {
  const issues = [];
  const add = (severity, msg) => issues.push({ severity, issue: msg });

  if (renderer.toneMapping === THREE.NoToneMapping) add('high', 'renderer.toneMapping is NoToneMapping → anything above 1.0 clips to flat white. Use ACESFilmicToneMapping.');
  if (renderer.outputColorSpace !== THREE.SRGBColorSpace) add('high', 'renderer.outputColorSpace is not SRGBColorSpace.');
  if (renderer.toneMappingExposure > 1.3) add('medium', `toneMappingExposure ${renderer.toneMappingExposure} is high; lower lights instead of raising exposure.`);

  if (composer) {
    const last = composer.passes[composer.passes.length - 1];
    if (!composer.passes.some((p) => p.isOutputPass)) add('high', 'EffectComposer has no OutputPass → renderer tone mapping and sRGB are never applied.');
    else if (!last.isOutputPass) add('medium', 'OutputPass is not the last pass; passes after it run on tone-mapped sRGB data.');
    if (!composer.renderTarget1.samples) add('medium', 'Composer render target has samples = 0 → no MSAA, bright edges will crawl. Use createComposer().');
    for (const p of composer.passes) {
      if (p instanceof UnrealBloomPass || p.highPassUniforms) {
        if (p.threshold < 0.9) add('high', `Bloom threshold ${p.threshold} → every lit surface blooms. Use ~1.0: bloom runs on linear HDR before tone mapping.`);
        if (p.strength > 0.8) add('medium', `Bloom strength ${p.strength} is heavy; 0.2–0.6 reads as glow, above that as fog.`);
      }
    }
  }

  const lights = [];
  scene.traverse((o) => o.isLight && lights.push(o));
  const g = lights.filter((l) => l.isAmbientLight || l.isHemisphereLight || l.isDirectionalLight).reduce((s, l) => s + l.intensity, 0);
  const env = scene.environment ? (scene.environmentIntensity ?? 1) : 0;
  if (g + 1.5 * env > 4.2) add('high', `Global light sum ${g.toFixed(2)} (+env ${env}) exceeds ~3.5 budget → overexposed. Run tameLights().`);
  lights.forEach((l) => {
    if (l.isAmbientLight && l.intensity > 0.3) add('medium', `AmbientLight intensity ${l.intensity} washes the scene flat; prefer HemisphereLight ≤ 0.6 or an environment map.`);
    if ((l.isPointLight || l.isSpotLight) && l.decay < 2) add('high', `${l.type} decay ${l.decay} → no physical falloff, saturates nearby surfaces.`);
    if (l.castShadow && l.shadow.bias === 0 && l.shadow.normalBias === 0) add('high', `${l.type} casts shadows with zero bias → shadow acne (striped flicker).`);
  });
  if (lights.filter((l) => l.castShadow).length > 2) add('medium', 'More than 2 shadow-casting lights.');

  const seen = new Set();
  scene.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of [].concat(o.material)) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      if (m.isMeshStandardMaterial && m.metalness > 0.5 && m.roughness < 0.15) add('medium', `${m.name || m.type}: metal with roughness ${m.roughness} → sparkling specular fireflies.`);
      if (m.isMeshStandardMaterial && m.emissiveIntensity > 3) add('medium', `${m.name || m.type}: emissiveIntensity ${m.emissiveIntensity} > 3.`);
      if (m.toneMapped === false && (m.color?.r + m.color?.g + m.color?.b) > 2.5) add('low', `${m.name || m.type}: toneMapped=false bright colour will ignore exposure.`);
      if (m.map && m.map.colorSpace !== THREE.SRGBColorSpace) add('medium', `${m.name || m.type}.map is not SRGBColorSpace → washed-out colours.`);
    }
  });

  if (issues.length) console.table(issues);
  else console.info('[hdr-lighting] audit clean');
  return issues;
}
