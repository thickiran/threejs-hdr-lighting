# Flicker, shimmer and sparkle — causes and fixes

Work through these in order; the first three cause most reports.

## 1. Shadow acne — fine stripes or moiré that crawl as the camera moves
**Cause:** shadow-casting light with `shadow.bias = 0` and `shadow.normalBias = 0`; surfaces shadow themselves.
**Fix:**
```js
light.shadow.bias = -0.0004;      // -0.0001 … -0.001
light.shadow.normalBias = 0.03;   // world units; 0.02–0.06 at meter scale
```
Too much normalBias → shadows detach from contact ("peter-panning"); lower it.

## 2. Shadow swimming — shadow edges shimmer/crawl every frame on a moving scene
**Cause:** the directional light (and its shadow camera) is moved with the player/vehicle every frame by fractional amounts. The shadow map is re-rasterised at a sub-texel offset each frame, so every edge re-quantises differently. Typical code: `sun.position.copy(car.position).add(offset); sun.target.position.copy(car.position);`
**Fix:** snap the shadow camera to whole shadow-map texels in light space.
```js
const follow = createShadowFollower(sun, new THREE.Vector3(12, 20, 8));
// per frame
follow(car.position);
```
Also: keep the shadow frustum tight (`left/right/top/bottom` ≈ ±15–25 m for a following camera), `mapSize` 2048, and don't resize the frustum every frame.

## 3. Specular fireflies — single pixels sparkle on and off on metal/glossy surfaces
**Cause:** `metalness ≈ 1` with `roughness < 0.15` under a strong key light produces sub-pixel highlights far above 1.0. They alias as the camera moves; bloom then turns each into a flashing star.
**Fix:**
- roughness floor ≈ 0.2 on metals (`tameLights` does this), or use a roughness map.
- MSAA on the composer target (`samples: 4`) — see #4.
- bloom `threshold` ≥ 1.0 (it runs on linear HDR — a sunlit white wall is already ~1.0), `strength` ≤ 0.6.
- `renderer.setPixelRatio(Math.min(devicePixelRatio, 2))`.

## 4. Crawling edges after adding post-processing
**Cause:** `new EffectComposer(renderer)` creates a render target with **no multisampling**. `antialias: true` on the renderer only affects the default framebuffer, which the composer no longer renders the scene into.
**Fix:** pass an MSAA half-float target (what `createComposer` does):
```js
const rt = new THREE.WebGLRenderTarget(w * dpr, h * dpr, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, rt);
composer.setPixelRatio(dpr); composer.setSize(w, h);
```
Alternative on low-end: no MSAA, add `SMAAPass` or `FXAAPass` *after* OutputPass (they expect sRGB input).

## 5. Strobing "flicker effect" on lamps, fire, neon
**Cause:** `light.intensity = base + Math.random() * k` every frame → uncorrelated values at 60–144 Hz = strobe.
**Fix:** smooth noise, ±5–12 %:
```js
const flick = createLightFlicker(lamp, { amount: 0.08, speed: 2 });
renderer.setAnimationLoop((t) => { flick(t / 1000); /* ... */ });
```
For a "faulty fluorescent" look, use occasional *discrete* dropouts on a timer (every 1–4 s, 60–120 ms long), not per-frame random.

## 6. Z-fighting — two surfaces alternate patches as the camera moves
**Cause:** coplanar faces (decals, road markings, emissive panels on walls), or a camera depth range like `near 0.001, far 100000`.
**Fix:** lift decals 1–5 mm off the surface or use `material.polygonOffset = true; polygonOffsetFactor = -1; polygonOffsetUnits = -1`. Camera `near ≥ 0.1`, `far / near ≤ 10⁴`. Very large worlds: `new WebGLRenderer({ logarithmicDepthBuffer: true })` (costs perf, breaks some effects).

## 7. Frame hitches that look like flicker when lights turn on/off
**Cause:** changing the *number* of lights (adding/removing, `visible` toggles, `castShadow` toggles) forces every material to recompile.
**Fix:** create all lights up front; switch with `intensity = 0`.

## 8. Exposure "pumping"
**Cause:** continuous auto-exposure that reacts to the frame it just tone-mapped.
**Fix:** don't. Use `calibrateExposure` once at load (or on a scene change), then leave exposure fixed. If you must adapt, lerp exposure with a time constant ≥ 1 s.

## 9. Bloom halos that breathe or pop
**Cause:** low threshold + small bright objects entering/leaving the view, or bloom resolution changing on resize without `composer.setSize`.
**Fix:** threshold ≥ 1.0, strength ≤ 0.6, emissive ≤ 3, always call `post.setSize` on resize.
