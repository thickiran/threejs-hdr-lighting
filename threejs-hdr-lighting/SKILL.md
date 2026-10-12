---
name: threejs-hdr-lighting
description: Use whenever you build or edit a three.js, react-three-fiber or WebGL scene that has lights, shadows, emissive materials or bloom — or when a 3D scene looks blown out, washed out, too bright, flat, or has flickering, shimmering or sparkling lights/shadows. Applies ACES filmic tone mapping, a light-intensity budget, correct post-processing order and flicker fixes.
---

# three.js HDR lighting: ACES + exposure discipline

Agent-built three.js scenes almost always ship **overexposed** and often **flicker**, and nobody notices until a human looks. The causes are mechanical and predictable, so fix them by default on every scene with lights — don't wait to be asked.

Bundled files:
- `scripts/hdr-lighting.js` — drop-in ES module: `setupRenderer`, `createComposer`, `createLightRig`, `tameLights`, `auditLighting`, `measureFrame`, `calibrateExposure`, `createShadowFollower`, `createLightFlicker`.
- `scripts/lint-lighting.mjs` — static check: `node scripts/lint-lighting.mjs <file|dir>` (exit 1 on HIGH issues).
- `references/flicker.md` — every flicker cause with the exact fix. Read it when anything flickers, shimmers or sparkles.
- `references/light-budget.md` — intensity tables per light type and scene mood, point-light maths, R3F / pmndrs postprocessing notes.

## Why scenes blow out

1. **No tone mapping.** `WebGLRenderer` defaults to `NoToneMapping`. Lit values above 1.0 hard-clip to flat white; highlights lose all shape.
2. **Light stacking.** Ambient 0.5 + hemisphere 1 + directional 2 + a second directional "for fill" — each looked fine alone; together a white wall hits 2–3× clip.
3. **Point lights without falloff.** `decay: 0` (old tutorials) or intensities of 100+ with no regard to scene scale.
4. **Composer without OutputPass.** With `EffectComposer`, the renderer's tone mapping does *not* run on render targets. Only `OutputPass` applies ACES + exposure + sRGB. Missing it = untonemapped, clipped image.
5. **Bloom at threshold 0–0.5.** Everything above mid-grey glows; the image turns to fog.

## Why scenes flicker

Shadow acne (zero bias), shadow cameras that follow a moving player without texel snapping (shadow edges crawl every frame), specular fireflies on glossy metal amplified by bloom, `EffectComposer` dropping MSAA so bright edges alias, `Math.random()` intensity "flicker" effects, z-fighting from coplanar faces or a tiny camera near plane. Details and fixes in `references/flicker.md`.

## The default setup (do this every time)

Copy `scripts/hdr-lighting.js` next to the scene code (or inline its functions in a single-file artifact). Then:

```js
import { setupRenderer, createComposer, createLightRig, auditLighting } from './hdr-lighting.js';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.shadowMap.enabled = true;
setupRenderer(renderer, { exposure: 0.9 });          // ACES filmic, sRGB out, DPR ≤ 2

const { sun, hemi } = createLightRig(scene, 'daylight');   // key + soft fill, no AmbientLight
const post = createComposer(renderer, scene, camera, {
  bloom: { strength: 0.35, radius: 0.4, threshold: 1.0 },  // or bloom: false
});
addEventListener('resize', () => post.setSize(innerWidth, innerHeight));
renderer.setAnimationLoop(() => post.render());
auditLighting(scene, renderer, post.composer);       // dev-time console table
```

If you don't use `hdr-lighting.js`, the non-negotiables by hand:

```js
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;                  // 0.8–1.0; never fix brightness with exposure > 1.3
renderer.outputColorSpace = THREE.SRGBColorSpace;
colorTexture.colorSpace = THREE.SRGBColorSpace;      // map, emissiveMap only — normal/roughness stay linear
// composer: new WebGLRenderTarget(w, h, { type: HalfFloatType, samples: 4 })
//           RenderPass → UnrealBloomPass(res, 0.35, 0.4, 1.0) → OutputPass (LAST)
```

## Light budget (meters, physical lights, ACES @ 0.9)

| Light | Default | Range | Notes |
|---|---|---|---|
| DirectionalLight (key/sun) | 2.5 | 1.5–3.0 | One key light. A white surface facing it ≈ 0.8–1.0 linear. |
| HemisphereLight (fill) | 0.5 | 0.3–0.8 | Replaces AmbientLight; keeps shape. |
| AmbientLight | 0 | 0–0.2 | Avoid. Flattens and washes out. |
| `scene.environmentIntensity` (PMREM env) | 0.35 | 0.2–1.0 | Each 1.0 of env ≈ 1.5 of direct budget — cut direct lights when env is high. `tameLights` caps it at 0.35 (pass `maxEnvironmentIntensity: 1` for studio/product scenes). |
| PointLight / SpotLight | `4 × d²` | — | `d` = typical distance (m) to the surfaces it lights. **decay = 2 always.** Set `distance` for culling. |
| `emissiveIntensity` | 1–2 | ≤ 3 | Bloom runs on linear HDR: threshold 1.0 catches emissives and true highlights, not lit walls. |

**Rule:** ambient + hemisphere + directional intensities sum to ≈ 3.5 or less (minus 1.5 per 1.0 of environment). Need it brighter? Raise the key light, not the fill; never add a second directional "to brighten".

Full tables per mood (night, studio, interior, neon) and R3F equivalents: `references/light-budget.md`.

## Retrofitting an existing scene (e.g. an artifact someone says is "too bright" or "flickering")

1. Run the static lint on the source: `node scripts/lint-lighting.mjs app.js`. Fix every HIGH.
2. At runtime, after the scene is built:
   ```js
   setupRenderer(renderer);                    // if tone mapping was missing
   tameLights(scene);                          // scales budgets, decay → 2, bias, roughness floor, sRGB maps
   const post = createComposer(renderer, scene, camera);   // replaces a composer without MSAA/OutputPass
   await calibrateExposure(renderer, () => post.render()); // one-shot: clipped < 1.5 %, mean ≈ 0.42
   auditLighting(scene, renderer, post.composer);
   ```
   `tameLights` scales all global lights together, so the original key/fill ratio survives.
3. Moving shadows (vehicle, character, camera-following sun): replace `sun.position.copy(player.position).add(offset)` with `const follow = createShadowFollower(sun, offset)` and call `follow(player.position)` each frame.
4. Flicker effects (fire, neon, faulty lamp): replace `light.intensity = base + Math.random()*k` with `createLightFlicker(light, { amount: 0.08, speed: 2 })`.

## Verify before you say it's done

- `auditLighting()` prints no HIGH rows.
- `measureFrame(renderer)` right after a render: `clipped < 0.02` and `mean` in 0.30–0.55 (night scenes 0.12–0.3).
- Orbit or drive the camera for a few seconds: shadow edges stay still, no sparkles on metal, no strobing.
- Bright things still look bright: a sun-lit white wall should be near-white with visible shading, not flat #FFFFFF.

## Choosing the tone mapper

- **ACES filmic** (default here): cinematic contrast, highlights roll off, saturated lights desaturate toward white as they get very bright — the "film" look.
- **AgX**: softer, keeps hue in very bright saturated lights (neon, lasers). Use if ACES turns your red neon orange-white.
- **Neutral** (Khronos PBR Neutral): product / e-commerce colours must match the brand swatch.

`setupRenderer(renderer, { toneMapping: 'agx' | 'neutral' })`. Exposure ranges stay the same.

## Don'ts

- Don't fix a dark scene by raising `toneMappingExposure` above ~1.3 — raise the key light.
- Don't add tone mapping in a custom ShaderPass *and* keep OutputPass — double tone mapping.
- Don't set `toneMapped: false` on materials to "make them pop" — they will ignore exposure and clip.
- Don't toggle `light.visible` or add/remove lights at runtime — it recompiles every shader (frame hitch). Set `intensity = 0`.
- Don't use `PCFSoftShadowMap` — removed in recent three.js; use `PCFShadowMap` + `shadow.radius`.
