# Light budget reference

All values assume: three.js r155+ (physical light units, no legacy lights), scene in **meters**, `ACESFilmicToneMapping`, `toneMappingExposure` ≈ 0.9, surface albedo ≈ 0.5–0.8.

## How the numbers relate to pixels

In physical mode, a white Lambert surface lit head-on by a DirectionalLight of intensity `I` has linear radiance ≈ `I / π`. So intensity ≈ 3 puts a white wall at ~1.0 linear before tone mapping. ACES (with three's 1/0.6 pre-scale) rolls that off to near-white **with shading preserved**. Every light you add on top pushes that wall further into the shoulder until it reads as flat white.

Ambient, hemisphere and directional intensities add up roughly linearly on an up-facing surface. Hence the global budget:

> **ambient + hemisphere + directional ≲ 3.5 − 1.5 × environmentIntensity**

## Presets (`createLightRig(scene, name)`)

| Preset | Sun (dir) | Hemi | Env | Exposure | Use for |
|---|---|---|---|---|---|
| daylight | 2.6 | 0.55 | 0.35 | 0.9 | outdoor, games, maps |
| overcast | 1.0 | 1.1 | 0.5 | 1.0 | soft, shadowless |
| golden | 2.0 `#ffc58a` | 0.35 | 0.25 | 0.95 | warm low sun |
| studio | 1.6 | 0.25 | 0.8 | 1.0 | product shots with RoomEnvironment |
| night | 0.3 `#9db4ff` | 0.12 | 0.08 | 1.1 | moonlight; practical lights do the work |

## Point and spot lights (candela)

Irradiance at distance `d` ≈ `intensity / d²` (with `decay = 2`). To make a lamp light the surfaces around it about as strongly as a sun of `E`, use `intensity ≈ E × d²`.

| Situation | Typical d | Intensity |
|---|---|---|
| Desk lamp onto desk | 0.6 m | 1–3 |
| Ceiling light in a room | 2.5 m | 15–30 |
| Street lamp onto road | 5 m | 60–120 |
| Stadium / floodlight | 20 m | 800–2000 (prefer SpotLight) |
| Neon sign "spill" | 1 m | 1–3, with emissive 1.5–2.5 on the tube |

Always set `distance` (≈ 3–4 × d) so the light is culled beyond its useful range. Keep **decay = 2**.

## Environment maps

```js
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.35;  // studio up to 1.0; outdoor game 0.2–0.4
```
RoomEnvironment at intensity 1 is already a fully lit studio. With it at 1.0, the direct light budget drops to ~2.0.

## Emissive

`emissive` colour × `emissiveIntensity` is added after lighting. With bloom threshold 1.0 (the pass runs on linear HDR, before tone mapping):
- `emissiveIntensity` 1 → visible, no glow
- 1.5–2.5 → clean glow
- > 3 → blob; ACES pushes it to white

## react-three-fiber

R3F's `<Canvas>` already defaults to ACES + sRGB. Don't pass `flat` (that's NoToneMapping). Set exposure with `gl={{ toneMappingExposure: 0.9 }}`.

```jsx
<Canvas shadows gl={{ toneMappingExposure: 0.9 }} camera={{ near: 0.1, far: 500 }}>
  <hemisphereLight args={['#dfeaff', '#4a4136', 0.5]} />
  <directionalLight position={[12, 20, 8]} intensity={2.5} castShadow
    shadow-mapSize={[2048, 2048]} shadow-bias={-0.0004} shadow-normalBias={0.03} />
  <Environment preset="city" environmentIntensity={0.35} />
</Canvas>
```

With `@react-three/postprocessing`, the renderer's tone mapping is not applied to the composer output — tone map explicitly as the last effect, and give it MSAA:

```jsx
<EffectComposer multisampling={4}>
  <Bloom intensity={0.35} luminanceThreshold={1} luminanceSmoothing={0.1} mipmapBlur />
  <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
</EffectComposer>
```

You can call `tameLights(scene)` / `auditLighting(scene, gl)` from `useThree()` inside an effect.
