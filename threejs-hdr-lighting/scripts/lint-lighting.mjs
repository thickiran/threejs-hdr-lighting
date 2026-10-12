#!/usr/bin/env node
/**
 * lint-lighting.mjs — static check for three.js lighting that will blow out or flicker.
 *
 *   node lint-lighting.mjs path/to/app.js [more files or folders...]
 *
 * Exit code 1 if any HIGH issue is found. Heuristic (regex-based), so it reads code the
 * way a reviewer would skim it; confirm at runtime with auditLighting() from hdr-lighting.js.
 */
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';

const EXT = new Set(['.js', '.mjs', '.ts', '.jsx', '.tsx', '.html', '.vue', '.svelte']);
const files = [];
const walk = (p) => {
  const s = statSync(p);
  if (s.isDirectory()) {
    for (const f of readdirSync(p)) if (!f.startsWith('.') && f !== 'node_modules' && f !== 'dist') walk(join(p, f));
  } else if (EXT.has(extname(p))) files.push(p);
};
process.argv.slice(2).forEach(walk);
if (!files.length) {
  console.error('usage: node lint-lighting.mjs <file|dir> [...]');
  process.exit(2);
}

const num = (s) => parseFloat(s);
const findings = [];
const flag = (file, src, idx, severity, msg) => {
  const line = idx == null ? 0 : src.slice(0, idx).split('\n').length;
  findings.push({ severity, where: `${file}${line ? ':' + line : ''}`, msg });
};

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  if (!/three|THREE|@react-three/.test(src)) continue;
  const usesR3F = /@react-three\/fiber/.test(src);
  const usesRenderer = /new\s+(THREE\.)?WebGLRenderer\b/.test(src);
  const usesComposer = /new\s+(THREE\.)?EffectComposer\b/.test(src);

  // Tone mapping
  if (usesRenderer && !/toneMapping\s*=\s*(THREE\.)?(ACESFilmic|AgX|Neutral)ToneMapping/.test(src)) {
    flag(file, src, null, 'HIGH', 'WebGLRenderer without ACES/AgX/Neutral tone mapping — default NoToneMapping clips every highlight to flat white.');
  }
  let m;
  const reExp = /toneMappingExposure\s*=\s*([\d.]+)/g;
  while ((m = reExp.exec(src))) if (num(m[1]) > 1.3) flag(file, src, m.index, 'MEDIUM', `toneMappingExposure ${m[1]} — lower the lights instead.`);
  if (usesComposer && !/OutputPass/.test(src)) flag(file, src, null, 'HIGH', 'EffectComposer without OutputPass — tone mapping and sRGB conversion never run.');
  if (usesComposer && !/samples\s*:/.test(src)) flag(file, src, null, 'MEDIUM', 'EffectComposer without an MSAA render target (samples: 4) — antialias:true is ignored, edges crawl.');
  if (/<EffectComposer/.test(src) && !/<ToneMapping/.test(src)) flag(file, src, null, 'HIGH', '@react-three/postprocessing EffectComposer without <ToneMapping mode={ToneMappingMode.ACES_FILMIC} /> as the last effect.');
  if (usesR3F && /<Canvas[^>]*\bflat\b/.test(src)) flag(file, src, src.indexOf('flat'), 'HIGH', '<Canvas flat> disables tone mapping.');

  // Lights
  const reLight = /new\s+(?:THREE\.)?(AmbientLight|HemisphereLight|DirectionalLight|PointLight|SpotLight)\s*\(([^)]*)\)/g;
  let globalSum = 0;
  while ((m = reLight.exec(src))) {
    const type = m[1];
    const args = m[2].split(',').map((a) => a.trim());
    const intensityArg = type === 'HemisphereLight' ? args[2] : args[1];
    const v = intensityArg && /^[\d.]+$/.test(intensityArg) ? num(intensityArg) : null;
    if (v != null && ['AmbientLight', 'HemisphereLight', 'DirectionalLight'].includes(type)) globalSum += v;
    if (type === 'AmbientLight' && v != null && v > 0.3) flag(file, src, m.index, 'MEDIUM', `AmbientLight ${v} — washes the scene flat; ≤ 0.2 or use HemisphereLight / environment.`);
    if (type === 'DirectionalLight' && v != null && v > 4) flag(file, src, m.index, 'HIGH', `DirectionalLight ${v} — key light above ~3 blows out white surfaces under ACES.`);
    if ((type === 'PointLight' || type === 'SpotLight')) {
      const decayIdx = type === 'PointLight' ? 3 : 5;
      if (args[decayIdx] != null && /^[\d.]+$/.test(args[decayIdx]) && num(args[decayIdx]) < 2) flag(file, src, m.index, 'HIGH', `${type} decay ${args[decayIdx]} — no physical falloff, saturates nearby surfaces.`);
    }
  }
  const reDecay = /\.decay\s*=\s*([\d.]+)/g;
  while ((m = reDecay.exec(src))) if (num(m[1]) < 2) flag(file, src, m.index, 'HIGH', `decay = ${m[1]} — use 2 (physical).`);
  if (globalSum > 4) flag(file, src, null, 'HIGH', `Ambient + hemisphere + directional intensities sum to ${globalSum.toFixed(2)} (budget ≈ 3.5) — overexposed.`);

  // Bloom
  const reBloom = /new\s+(?:THREE\.)?UnrealBloomPass\s*\(((?:[^()]|\([^()]*\))*)\)/g;
  while ((m = reBloom.exec(src))) {
    const args = m[1].replace(/\([^()]*\)/g, '()').split(',').map((a) => a.trim());
    const strength = num(args[1]), threshold = num(args[3]);
    if (!Number.isNaN(threshold) && threshold < 0.9) flag(file, src, m.index, 'HIGH', `UnrealBloomPass threshold ${threshold} — every lit surface blooms. Use 1.0 (HDR, pre-tone-map).`);
    if (!Number.isNaN(strength) && strength > 0.8) flag(file, src, m.index, 'MEDIUM', `UnrealBloomPass strength ${strength} — 0.2–0.6 reads as glow.`);
  }
  const reThr = /\.threshold\s*=\s*([\d.]+)/g;
  while ((m = reThr.exec(src))) if (num(m[1]) < 0.9) flag(file, src, m.index, 'HIGH', `bloom threshold ${m[1]} — use 1.0 (HDR, pre-tone-map).`);
  const reLumThr = /luminanceThreshold\s*[=:{]\s*\{?\s*([\d.]+)/g;
  while ((m = reLumThr.exec(src))) if (num(m[1]) < 0.9) flag(file, src, m.index, 'HIGH', `luminanceThreshold ${m[1]} — use 1.0 (HDR, pre-tone-map).`);

  // Emissive / materials
  const reEm = /emissiveIntensity\s*[:=]\s*([\d.]+)/g;
  while ((m = reEm.exec(src))) if (num(m[1]) > 3) flag(file, src, m.index, 'MEDIUM', `emissiveIntensity ${m[1]} — > 3 blooms into a blob.`);
  const reRough = /roughness\s*[:=]\s*(0(?:\.0\d*|\.1\d*)?|0)\b/g;
  while ((m = reRough.exec(src))) {
    const ctx = src.slice(Math.max(0, m.index - 200), m.index + 200);
    if (/metalness\s*[:=]\s*(1|0\.[6-9])/.test(ctx)) flag(file, src, m.index, 'MEDIUM', `Metal with roughness ${m[1]} — specular fireflies sparkle/flicker under bright lights. Use ≥ 0.2.`);
  }
  if (/toneMapped\s*[:=]\s*false/.test(src)) flag(file, src, src.search(/toneMapped\s*[:=]\s*false/), 'LOW', 'toneMapped: false — this material ignores exposure; make sure it is meant to be > 1.0.');

  // Flicker
  const reRand = /\.intensity\s*[+\-*]?=\s*[^;\n]*Math\.random\(\)/g;
  while ((m = reRand.exec(src))) flag(file, src, m.index, 'HIGH', 'Light intensity driven by Math.random() per frame → strobing. Use smooth noise (createLightFlicker).');
  if (/castShadow\s*=\s*true/.test(src)) {
    if (!/shadow\.(bias|normalBias)\s*=/.test(src) && !/shadow-(bias|normalBias)/.test(src)) flag(file, src, src.search(/castShadow\s*=\s*true/), 'HIGH', 'Shadows enabled with no shadow.bias / normalBias → shadow acne (striped flicker).');
  }
  if (/shadow\.camera/.test(src) && /(light|sun|dirLight)\w*\.position\.(copy|set|add)\([^)]*(player|car|bike|moto|vehicle|target|ship)/i.test(src) && !/createShadowFollower|texel|snap/i.test(src)) {
    flag(file, src, null, 'HIGH', 'Directional light follows a moving object without texel snapping → shadows shimmer/crawl every frame. Use createShadowFollower().');
  }
  if (/PCFSoftShadowMap/.test(src)) flag(file, src, src.indexOf('PCFSoftShadowMap'), 'LOW', 'PCFSoftShadowMap was removed in recent three.js; use PCFShadowMap + shadow.radius.');
  if (/camera\s*=\s*new\s+(THREE\.)?PerspectiveCamera\([^)]*,\s*0\.0+1\s*,/.test(src)) flag(file, src, null, 'MEDIUM', 'Camera near plane ≤ 0.01 → depth precision loss, z-fighting flicker. Use 0.1+.');
  if (/\.visible\s*=\s*(!|false|true)[^;]*;/.test(src) && /Light/.test(src) && /(light|lamp)\w*\.visible\s*=/i.test(src)) flag(file, src, src.search(/(light|lamp)\w*\.visible\s*=/i), 'MEDIUM', 'Toggling light.visible changes the light count → shader recompiles (frame hitch). Set intensity = 0 instead.');
}

const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
findings.sort((a, b) => order[a.severity] - order[b.severity]);
if (!findings.length) {
  console.log('lint-lighting: no issues found');
} else {
  for (const f of findings) console.log(`${f.severity.padEnd(6)} ${f.where}\n       ${f.msg}`);
  const h = findings.filter((f) => f.severity === 'HIGH').length;
  console.log(`\n${findings.length} issue(s), ${h} high`);
}
process.exit(findings.some((f) => f.severity === 'HIGH') ? 1 : 0);
