# threejs-hdr-lighting

A Claude skill that stops three.js scenes from shipping **blown out** and **flickering**.

Agent-built three.js scenes almost always have the same problems: no tone mapping (the `WebGLRenderer` default is `NoToneMapping`), ambient + hemisphere + several directional lights stacked far past white, decay-0 point lights, bloom thresholds that make everything glow, shadows that swim when the sun follows the player, and `Math.random()` "flicker" that strobes. Nobody notices until a human looks.

This skill makes Claude set up **ACES filmic tone mapping, a light budget, a correct post-processing chain and flicker-safe shadows by default**, and gives it tools to retrofit and verify an existing scene.

**Explainer with a live before/after demo:** https://claude.ai/artifact/59KNHRh17Gpvvd3Zv5pJVu · the same page is in [`demo/`](demo/) (open `demo/index.html` over any static server).

## Install

**Claude app (web / desktop):** download [`threejs-hdr-lighting.zip`](threejs-hdr-lighting.zip) and upload it as a skill in Claude's Skills settings.

**Claude Code:**

```sh
git clone https://github.com/thickiran/threejs-hdr-lighting /tmp/hdr
cp -r /tmp/hdr/threejs-hdr-lighting ~/.claude/skills/          # personal
# or: cp -r /tmp/hdr/threejs-hdr-lighting .claude/skills/       # per project, shared via git
```

## What's inside

```
threejs-hdr-lighting/
├── SKILL.md                    # rules Claude follows: why scenes blow out, default setup, budget, verification
├── scripts/
│   ├── hdr-lighting.js         # drop-in ES module (three r155+)
│   └── lint-lighting.mjs       # static checker: node lint-lighting.mjs <file|dir>, exit 1 on HIGH issues
└── references/
    ├── flicker.md              # every flicker cause with the exact fix
    └── light-budget.md         # intensity tables, point-light maths, react-three-fiber notes
```

### `hdr-lighting.js`

| Call | What it does |
|---|---|
| `setupRenderer(renderer, { exposure, toneMapping })` | ACES filmic (or AgX / Neutral), exposure 0.9, sRGB output, DPR ≤ 2, PCF shadows |
| `createComposer(renderer, scene, camera, { bloom, samples })` | MSAA half-float target → RenderPass → UnrealBloomPass (threshold 1.0) → OutputPass |
| `createLightRig(scene, 'daylight' \| 'overcast' \| 'golden' \| 'studio' \| 'night')` | Key + hemisphere fill for new scenes, no AmbientLight |
| `tameLights(scene)` | Retrofit: caps ambient/env, scales stacked lights to budget (ratios kept), decay → 2 with compensation, shadow bias, metal roughness floor, emissive cap, sRGB colour maps. Returns the list of changes |
| `calibrateExposure(renderer, renderFn)` | One-shot auto exposure from read-back pixels (clipped < 1.5 %, mean 0.25–0.62) |
| `measureFrame(renderer)` | `{ mean, clipped, crushed }` of the frame just drawn |
| `createShadowFollower(sun, offset)` | Sun follows a moving target with texel-snapped shadows (no swimming) |
| `createLightFlicker(light, { amount, speed })` | Smooth-noise flicker instead of per-frame random |
| `auditLighting(scene, renderer, composer)` | Console table of everything still likely to blow out or flicker |

### Retrofit an existing scene in four calls

```js
import { setupRenderer, tameLights, createComposer, calibrateExposure } from './hdr-lighting.js';

setupRenderer(renderer);
tameLights(scene);
const post = createComposer(renderer, scene, camera);
renderer.setAnimationLoop(() => post.render());
await calibrateExposure(renderer, () => post.render());
```

Single-file pages can use this import map:

```html
<script type="importmap">
{ "imports": {
  "three": "https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js",
  "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/"
} }
</script>
```

## Light budget (meters, physical units, ACES @ 0.9)

| Light | Default | Range |
|---|---|---|
| DirectionalLight (key) | 2.5 | 1.5–3.0 |
| HemisphereLight (fill) | 0.5 | 0.3–0.8 |
| AmbientLight | 0 | 0–0.2 |
| `scene.environmentIntensity` | 0.35 | 0.2–1.0 |
| Point / Spot | `4 × d²` (d = metres to lit surface), decay 2 | — |
| `emissiveIntensity` | 1.5 | 1–3 |

**ambient + hemisphere + directional ≲ 3.5 − 1.5 × environmentIntensity.**

## Tested

three.js r186.1 in headless Chromium: the demo's "typical" setup reads ~99 % clipped pixels; after `tameLights` + `createComposer` + `calibrateExposure` the same scene reads < 1 % clipped at mean luma ≈ 0.5.

## License

MIT
