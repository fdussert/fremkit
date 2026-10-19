/**
 * Draws the scene on a WebGL canvas laid over the whole screen: haze behind, the worm's body
 * and maw, the sand it swims in, sand in the air, haze in front. Everything is procedural —
 * shaders and geometry built each frame from the timeline — so there is nothing to load.
 *
 * WebGL 1 on purpose: it is what every WebKit and Chromium the dashboard runs in can give.
 */
import { STRIDE } from './particles'
import { PLATE_FLOOR } from './timeline'

export interface Spine {
  /** Per sample, head first: x, y, tx, ty (unit tangent towards the tail), r, s. */
  data: Float32Array
  count: number
}
export const SPINE_STRIDE = 6
/** Floats per body vertex: x, y, tx, ty, v, s, r, plate phase, plate size, girth slope. */
const BODY_FLOATS = 10

export interface Maw {
  x: number; y: number
  /** Half-axes in pixels: `a` across the body, `b` along it towards the front. */
  ax: number; ay: number; bx: number; by: number
  r: number
  open: number
}

export interface Frame {
  t: number
  w: number; h: number
  /** +1 when the worm travels to the right. */
  dir: number
  spine: Spine
  maw: Maw
  /** The sand line's base, and up to `MAX_BULGES` mounds on it: x, height, half-width. */
  sand: number
  /** 1 while the sand stands, down to 0 as it drains away. */
  sandFade: number
  bulges: Float32Array
  particles: Float32Array
  particleCount: number
  /** 0..1: how thick the dust hangs, and where it is thickest. */
  haze: number
  hx: number; hy: number
}

export const MAX_BULGES = 10

export interface Renderer {
  draw(f: Frame): void
  dispose(): void
}

const NOISE = `
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
`

/** The low sun, from the upper left, a little towards the viewer. Shared by every shader. */
const SUN = `
const vec3 SUN = vec3(-0.62, -0.5, 0.6);
const vec3 KEY = vec3(1.0, 0.79, 0.52);
`

const BODY_VS = `
attribute vec2 aPos; attribute vec2 aTan; attribute float aV; attribute float aS; attribute float aR;
attribute float aPh; attribute float aRing; attribute float aSlope;
uniform vec2 uRes;
varying vec2 vTan; varying float vV; varying float vS; varying float vR; varying vec2 vPos;
varying float vPh; varying float vRing; varying float vSlope;
void main() {
  vTan = aTan; vV = aV; vS = aS; vR = aR; vPos = aPos; vPh = aPh; vRing = aRing; vSlope = aSlope;
  gl_Position = vec4(aPos.x / uRes.x * 2.0 - 1.0, 1.0 - aPos.y / uRes.y * 2.0, 0.0, 1.0);
}`

const BODY_FS = `
precision highp float;
varying vec2 vTan; varying float vV; varying float vS; varying float vR; varying vec2 vPos;
varying float vPh; varying float vRing; varying float vSlope;
uniform float uTime; uniform float uSand;
${NOISE}
${SUN}
// One armour plate: a raised, overhanging front edge, then a long slope back under the next one.
float plate(float f) { return smoothstep(0.0, 0.06, f) * (1.0 - 0.5 * f) * (0.82 + 0.18 * smoothstep(0.06, 0.3, f)); }
void main() {
  float av = abs(vV);
  float alpha = clamp((1.0 - av) * vR + 0.5, 0.0, 1.0);
  float v = clamp(vV, -0.999, 0.999);
  float z = sqrt(1.0 - v * v);
  vec2 t2 = normalize(vTan);
  vec2 n2 = vec2(-t2.y, t2.x);
  float circ = asin(v) * vR;
  // Plates bowed towards the head. Each has its own width, and its edge wanders around the body
  // and is offset from its neighbours', so no two rings line up.
  float bow = z * vR * 0.42 / vRing;
  float pl = vPh - bow;
  float ph0 = pl + 0.85 * vnoise(vec2(pl * 0.35, 3.0)) + 0.25 * vnoise(vec2(pl * 1.3, 9.0));
  float id0 = floor(ph0);
  float ph = ph0 + 0.3 * (vnoise(vec2(circ / vRing * 0.3 + id0 * 7.3, id0 * 1.7)) - 0.5);
  float id = floor(ph);
  float f = fract(ph);
  float own = hash(vec2(id, 4.1));
  // Each ring of armour is split into staggered segments, like scutes.
  float seg = circ / (vRing * (3.2 + own * 2.0)) + own * 5.0;
  float segF = fract(seg);
  float segId = floor(seg);
  float seam = 1.0 - smoothstep(0.0, 0.025, min(segF, 1.0 - segF));
  seam *= smoothstep(0.08, 0.2, f) * (1.0 - smoothstep(0.55, 0.9, f)) * 0.6;
  float hgt = plate(f);
  float dh = clamp((plate(fract(ph + 0.015)) - plate(fract(ph - 0.015))) / 0.03, -6.0, 6.0);
  float big = fbm(vec2(vS * 0.008, circ * 0.012));
  float mid = fbm(vec2(vS * 0.05, circ * 0.07) + 7.0);
  float grit = vnoise(vec2(vS * 0.5, circ * 0.55));
  float pits = smoothstep(0.62, 0.8, vnoise(vec2(vS * 0.22, circ * 0.25) + 13.0));
  // A surface of revolution: where the girth changes fast (the rounded tips), the normal leans
  // along the body, so the tip is shaded as a dome rather than as the end of a pipe.
  vec3 N = normalize(vec3(n2 * v, z) - vec3(t2, 0.0) * clamp(vSlope, -8.0, 8.0));
  // Each scute tilted its own way, the ridges, and a roughness that kills any plastic sheen.
  float tilt = hash(vec2(id, segId)) - 0.5;
  N = normalize(N + vec3(t2, 0.0) * dh * 0.25 + vec3(n2, 0.0) * (tilt * 0.35 + (mid - 0.5) * 0.45)
    + vec3(t2, 0.0) * (grit - 0.5) * 0.28 + vec3(n2, 0.0) * (grit - 0.5) * 0.2);
  vec3 L = normalize(SUN);
  float ndl = dot(N, L);
  float diff = smoothstep(-0.2, 1.0, ndl);
  // Weathered hide: ochre to umber, every plate its own shade, blotched and pitted.
  vec3 ochre = vec3(0.56, 0.4, 0.25), umber = vec3(0.27, 0.17, 0.1);
  vec3 crust = mix(umber, ochre, clamp(big * 1.2 - 0.1 + (own - 0.5) * 0.35, 0.0, 1.0));
  crust = mix(crust, vec3(0.4, 0.22, 0.13), smoothstep(0.55, 0.8, mid) * 0.4);
  crust *= 0.78 + 0.3 * grit;
  crust *= 1.0 - 0.3 * pits;
  // Sand caught on the back, where the hide faces the sky.
  float dusted = smoothstep(0.0, 0.8, -N.y) * smoothstep(0.45, 0.8, mid + big * 0.3);
  crust = mix(crust, vec3(0.78, 0.62, 0.42), dusted * 0.45);
  // The folds under each overhang: shadowed, but packed with paler grit rather than black.
  // The step between plates: a thin dark seam where one goes under the next, grit packed in it.
  float fold = 1.0 - smoothstep(0.0, 0.022, f);
  vec3 foldC = mix(vec3(0.22, 0.14, 0.08), vec3(0.6, 0.47, 0.32), smoothstep(0.4, 0.75, grit + mid * 0.4));
  vec3 hide = mix(crust, foldC, fold * 0.85);
  hide = mix(hide, foldC * 0.85, seam * 0.6);
  // Each plate's lip overhangs the end of the one before it and casts a soft shadow there.
  float shade = smoothstep(0.62 + 0.12 * own, 1.0, f);
  float ao = (1.0 - 0.55 * shade * shade) * (0.75 + 0.25 * hgt) * (1.0 - 0.3 * seam);
  vec3 amb = vec3(0.1, 0.065, 0.045) + vec3(0.32, 0.2, 0.1) * max(N.y, 0.0) * 0.45 + vec3(0.15, 0.14, 0.17) * max(-N.y, 0.0) * 0.3;
  vec3 col = hide * ao * (amb + KEY * 1.55 * diff);
  // Worn front edges of the plates catch the low sun, chipped here and there.
  // The raised leading edge of each plate, a step facing the low sun.
  float lip = smoothstep(0.015, 0.04, f) * (1.0 - smoothstep(0.07, 0.17, f));
  float worn = smoothstep(0.3, 0.6, vnoise(vec2(circ * 0.09, id * 3.0)));
  col += vec3(1.0, 0.82, 0.58) * lip * (0.55 + 0.45 * worn) * (0.25 + max(ndl, 0.0)) * 0.75 * (0.6 + 0.4 * grit) * crust * 1.8;
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  col += KEY * pow(max(dot(N, H), 0.0), 10.0) * 0.06 * (1.0 - fold);
  // Rim light on the edge that faces the sun, hot and thin.
  float rim = pow(1.0 - z, 2.5) * max(dot(n2 * sign(vV), normalize(L.xy)), 0.0);
  col += vec3(1.0, 0.68, 0.38) * rim * 0.7 * (1.0 - fold) * (0.6 + 0.4 * worn);
  // Darker, still wet with sand, just out of the ground.
  float fresh = smoothstep(90.0, 0.0, uSand - vPos.y);
  col *= 1.0 - fresh * 0.3;
  col = col / (1.0 + col * 0.2);
  gl_FragColor = vec4(col * alpha, alpha);
}`

/** The maw's quad, as a triangle strip in its own unit square. */
const MAW_CORNERS: ReadonlyArray<readonly [number, number]> = [[-1, -1], [1, -1], [-1, 1], [1, 1]]

const QUAD_VS = `
attribute vec2 aPos; attribute vec2 aUv;
uniform vec2 uRes;
varying vec2 vUv;
void main() { vUv = aUv; gl_Position = vec4(aPos.x / uRes.x * 2.0 - 1.0, 1.0 - aPos.y / uRes.y * 2.0, 0.0, 1.0); }`

const MAW_FS = `
precision highp float;
varying vec2 vUv;
uniform float uOpen; uniform float uTime; uniform float uPx; uniform vec2 uA; uniform vec2 uB; uniform float uShow;
${NOISE}
${SUN}
const float TAU = 6.2831853;
void main() {
  vec2 uv = vUv;
  float rho = length(uv);
  float th = atan(uv.y, uv.x);
  float aa = uPx * 1.5;
  // Five lobes, none quite like the others, peeling back past the rim of the body as they open.
  float lobeF = th / TAU * 5.0 + 0.25;
  float idx = floor(lobeF);
  float lobe = fract(lobeF) - 0.5;
  float own = hash(vec2(idx, 7.0));
  float tip = pow(max(1.0 - abs(2.0 * lobe), 0.0), 0.8);
  float ragged = (vnoise(vec2(th * 9.0, 2.0)) - 0.5) * 0.06;
  float outer = 1.0 + uOpen * (0.04 + (0.36 + 0.12 * own) * tip) + ragged * uOpen;
  float hole = uOpen * (0.86 - 0.1 * tip);
  float edge = 1.0 - smoothstep(outer - aa, outer + aa, rho);
  if (edge <= 0.0) discard;
  vec2 sunScreen = normalize(SUN.xy);
  vec2 dirScreen = normalize(uA * uv.x + uB * uv.y + 0.0001);
  float facingSun = dot(dirScreen, sunScreen);
  float inside = 1.0 - smoothstep(hole - aa, hole + aa, rho);
  float pr = clamp((rho - hole) / max(outer - hole, 0.001), 0.0, 1.0);
  // The lobes are the body's own armour: plates in bands across each lobe, worn at the edges,
  // the same ochre-to-umber hide. Folded back, their underside shows: dark, wet, glistening.
  float band = pr * 3.5 + vnoise(vec2(lobe * 2.0, idx * 3.0)) * 0.35 + lobe * lobe * 1.2;
  float bf = fract(band);
  float bandId = floor(band);
  float n1 = fbm(vec2(th * 5.0, rho * 6.0) + idx);
  float grit = vnoise(vec2(th * 60.0, rho * 40.0));
  vec3 hide = mix(vec3(0.27, 0.17, 0.1), vec3(0.56, 0.4, 0.25), clamp(n1 * 1.2 - 0.1 + (hash(vec2(idx, bandId)) - 0.5) * 0.3, 0.0, 1.0));
  hide *= 0.78 + 0.3 * grit;
  // The same plates as the body: a thin seam, a lit lip, a shadow cast on the plate below.
  hide = mix(hide, vec3(0.22, 0.14, 0.08), (1.0 - smoothstep(0.0, 0.04, bf)) * 0.8);
  hide *= 1.0 - 0.45 * smoothstep(0.65, 1.0, bf);
  hide += vec3(0.5, 0.38, 0.24) * smoothstep(0.03, 0.06, bf) * (1.0 - smoothstep(0.08, 0.18, bf)) * (0.3 + max(facingSun, 0.0)) * 0.6;
  // Lit like the body: each lobe a thick curved slab, its normal turning across it and flaring
  // outwards towards its rim.
  vec2 radial = dirScreen;
  vec2 across = vec2(-radial.y, radial.x);
  vec3 lobeN = normalize(vec3(across * sin(lobe * 3.14159) * 0.8 + radial * (pr - 0.35) * 0.9 * uOpen, 1.0));
  float lobeLight = 0.32 + 1.35 * smoothstep(-0.2, 1.0, dot(lobeN, normalize(SUN)));
  hide *= lobeLight;
  vec3 under = mix(vec3(0.05, 0.028, 0.02), vec3(0.2, 0.12, 0.08), smoothstep(0.0, 0.8, pr));
  under *= 0.8 + 0.3 * n1;
  float wet = smoothstep(0.72, 0.9, vnoise(vec2(th * 16.0, pr * 7.0) + idx * 5.0)) * smoothstep(0.1, 0.4, pr) * (1.0 - smoothstep(0.5, 0.85, pr)) * (0.4 + 0.6 * max(facingSun, 0.0));
  under += vec3(0.75, 0.66, 0.55) * wet * 0.35;
  // Only the inner part of each lobe shows its underside; the outer part curls back and shows hide.
  float undersideShows = smoothstep(0.15, 0.6, uOpen) * (1.0 - smoothstep(0.22, 0.45, pr));
  vec3 petal = mix(hide, under, undersideShows);
  float dome = cos(lobe * 3.14159);
  petal *= 0.7 + 0.3 * dome;
  vec3 noseN = normalize(vec3(dirScreen * min(rho, 1.0) * 0.8, sqrt(max(1.0 - rho * rho, 0.0)) + 0.3));
  float noseLight = 0.45 + 1.0 * max(dot(noseN, normalize(SUN)), 0.0);
  petal *= mix(noseLight, 1.0, smoothstep(0.1, 0.5, uOpen));
  float seamL = smoothstep(0.44, 0.5, abs(lobe)) * (1.0 - uOpen * 0.7);
  petal *= 1.0 - seamL * 0.6;
  // The rim of each lobe has real thickness: a worn, sunlit edge band, darker just inside it
  // where the lobe's underside begins to show.
  float thick = 0.035 + 0.03 * vnoise(vec2(th * 14.0, idx));
  float rimBand = smoothstep(thick + 0.015, thick - 0.01, outer - rho);
  float rimInner = smoothstep(thick + 0.04, thick + 0.015, outer - rho) * (1.0 - rimBand);
  vec3 rimC = mix(vec3(0.3, 0.21, 0.13), vec3(0.85, 0.66, 0.44), smoothstep(-0.4, 0.8, facingSun)) * (0.75 + 0.4 * grit);
  petal = mix(petal, rimC, rimBand * uOpen * (0.6 + 0.4 * dome));
  petal *= 1.0 - 0.35 * rimInner * uOpen;
  // The dark hinge where the lobes meet the body.
  petal *= 1.0 - 0.45 * smoothstep(0.05, 0.0, abs(rho - 1.0)) * uOpen;
  petal *= mix(smoothstep(0.02, 0.12, rho) * 0.7 + 0.3, 1.0, uOpen);
  vec3 col = petal;
  if (inside > 0.0 && hole > 0.02) {
    float d = rho / hole;
    // A deep throat: the faint wet walls near the lip fall away into black.
    vec3 throat = vec3(0.075, 0.042, 0.03) * smoothstep(0.25, 1.0, d);
    throat *= 0.7 + 0.5 * smoothstep(0.3, 0.6, fract(d * 9.0 + vnoise(vec2(th * 10.0, d * 3.0)) * 0.7));
    vec3 inner = throat;
    // Receding rings of crystal needles, the deepest first: thin, many, half clear. Light comes
    // through them from the mouth, so they glow pale against the dark behind, edges brightest.
    for (int k = 5; k >= 0; k--) {
      float fk = float(k);
      float R = hole * (0.99 - 0.145 * fk);
      float C = 40.0 - 4.0 * fk;
      float len = hole * (0.13 - 0.012 * fk);
      float cell = th / TAU * C + fk * 0.37;
      float vary = hash(vec2(floor(cell), fk));
      float b = fract(cell) - 0.5;
      float l = len * (0.75 + 0.5 * vary);
      float across = (rho - (R - l)) / l;
      b += (vary - 0.5) * 0.3 * (1.0 - across);
      if (across > 0.0 && across < 1.0) {
        float hw = 0.17 * pow(across, 1.3) + 0.01;
        float soft = uPx * C * 0.2 + 0.02;
        float tooth = 1.0 - smoothstep(hw - soft, hw + soft, abs(b));
        if (tooth > 0.0) {
          float depth = pow(1.0 - 0.15 * fk, 2.0);
          // Translucent: what is behind shows through, the edges and the tip glow.
          float edgeGlow = smoothstep(hw * 0.4, hw, abs(b));
          vec3 glass = vec3(0.78, 0.8, 0.76) * (0.25 + 0.55 * (1.0 - across) + 0.5 * edgeGlow);
          glass *= b > 0.0 ? 1.0 : 0.7;
          float glint = pow(max(0.0, sin(uTime * 2.2 + fk * 2.0 + floor(cell) * 1.7)), 40.0) * (1.0 - across);
          glass += vec3(1.0, 0.95, 0.85) * glint * 0.7;
          vec3 behind = inner;
          vec3 c = mix(behind, glass * depth, 0.6 + 0.3 * edgeGlow);
          inner = mix(inner, c, tooth);
        }
      }
      // The dark root of each ring.
      inner *= 1.0 - 0.5 * smoothstep(0.02, 0.0, abs(rho - R)) * step(rho, R + 0.025);
    }
    col = mix(col, inner, inside);
  }
  col = col / (1.0 + col * 0.15);
  edge *= uShow;
  gl_FragColor = vec4(col * edge, edge);
}`

const FULL_VS = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`

/**
 * The sand's shapes. Distances are in CSS pixels; `uBand` is how far the
 * sand has risen, so every dune grows with it and nothing shows before the sand does.
 */
const SAND_LIB = `
uniform vec2 uRes; uniform float uScale; uniform float uBase; uniform float uBand; uniform float uTime; uniform float uFade;
uniform vec3 uBulge[${MAX_BULGES}];
${NOISE}
// A better-mixed hash for per-pixel grain and dither: no lattice patterns, no blocks.
float hash21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash11(float x) { return hash21(vec2(x, x * 0.37 + 11.0)); }
// One field of dunes w pixels apart: each its own height, its crest set back along it, a long
// windward slope rising from the left and a short steep lee face, the crest left sharp.
float dunes(float x, float w, float seed) {
  float t = x / w + seed;
  float id = floor(t), f = fract(t);
  float k = 0.58 + 0.25 * hash11(id + seed * 13.0);
  float a = 0.35 + 0.65 * hash11(id * 1.7 + seed * 5.0);
  float h = f < k ? pow(f / k, 1.6) : pow((1.0 - f) / (1.0 - k), 1.15);
  // A soft trough between dunes, so the next windward slope does not start on a corner.
  h = mix(h, h * h * (3.0 - 2.0 * h), 0.35);
  return a * h;
}
float mounds(float x) {
  float y = 0.0;
  for (int i = 0; i < ${MAX_BULGES}; i++) {
    vec3 b = uBulge[i];
    if (b.z > 0.0) { float q = (x - b.x) / b.z; y += b.y * exp(-q * q); }
  }
  return y;
}
// Positions are warped and heights swell and die away along the strip, so no two stretches of
// sand look alike: a soft rise here, a flat pan there.
float warp(float x, float s) { return x + (vnoise(vec2(x * 0.0021, s)) - 0.5) * 380.0; }
float swell(float x, float s) { return 0.35 + 0.9 * smoothstep(0.15, 0.85, vnoise(vec2(x * 0.0011, s + 4.0))); }
// The sand's crest line (screen y, down is +): a few long, low dunes, mostly smooth, one or two
// soft rises.
float crestLine(float x) {
  float q = warp(x, 3.0);
  return uBase - uBand * (0.27 * swell(x, 3.0) * dunes(q, 1700.0, 2.2) + 0.04 * dunes(q, 640.0, 9.4))
    - mounds(x) * smoothstep(0.0, 60.0, uBand);
}
// Wind ripples: warped, of varying wavelength and direction, in patches, finer and fainter with
// distance (towards the crest, far near 1).
float ripples(vec2 p, float far) {
  vec2 w = vec2(fbm(p * vec2(0.0035, 0.012)), fbm(p * vec2(0.0035, 0.012) + 5.2)) - 0.5;
  vec2 q = p + w * vec2(90.0, 26.0);
  float ang = (vnoise(p * 0.0016 + 2.0) - 0.5) * 0.9;
  vec2 dir = vec2(sin(ang), cos(ang));
  float freq = mix(0.16, 0.42, far) * (0.75 + 0.5 * vnoise(p * 0.0025 + 9.0));
  float r = 1.0 - abs(sin(dot(q, dir) * freq));
  r = r * r * r;
  float patchy = smoothstep(0.3, 0.75, vnoise(p * vec2(0.003, 0.008) + 4.0));
  return (r - 0.25) * patchy * (1.0 - 0.7 * far);
}
// Light on a dune face from its slope: windward faces (rising to the right) look at the low sun
// on the left, lee faces fall into a cool shadow.
vec3 faceLight(float slope) {
  float lit = clamp(0.95 - slope * 2.6, 0.0, 2.0);
  return mix(vec3(0.62, 0.6, 0.72), vec3(1.18, 1.05, 0.9), smoothstep(0.35, 1.25, lit));
}
vec2 pix() { return vec2(gl_FragCoord.x, uRes.y * uScale - gl_FragCoord.y) / uScale; }
// Triangular dither, so the long gradients of sand and haze do not band.
vec3 dither(vec3 c) { return c + (hash21(gl_FragCoord.xy) + hash21(gl_FragCoord.yx + 7.0) - 1.0) / 255.0; }
`

/** The sand: the worm's own layer, which it ploughs, breaks out of and dives into. */
const SAND_FS = `
precision highp float;
${SAND_LIB}
void main() {
  vec2 p = pix();
  float ys = crestLine(p.x);
  float depth = p.y - ys;
  if (depth < -2.0 || uBand < 1.0) discard;
  float alpha = smoothstep(-1.0, 1.0, depth) * uFade;
  float slope = (crestLine(p.x + 10.0) - crestLine(p.x - 10.0)) / 20.0;
  float band = max(uRes.y - ys, 1.0);
  float u = clamp(depth / band, 0.0, 1.0);
  vec3 crest = vec3(0.95, 0.75, 0.48), body = vec3(0.8, 0.54, 0.31), deep = vec3(0.55, 0.33, 0.17);
  vec3 col = mix(crest, body, smoothstep(0.0, 22.0, depth));
  col = mix(col, deep, smoothstep(22.0, band * 0.95, depth) * 0.8);
  // The dune face just under the crest, lit on the windward side, in shadow on the lee.
  col *= mix(vec3(1.0), faceLight(slope), exp(-depth / 26.0));
  // Long soft swells across the foreground, so it is not one flat sheet.
  col *= 0.93 + 0.1 * fbm(vec2(p.x * 0.0022, p.y * 0.012) + 3.0);
  // Disturbed sand where the worm passes: darker, churned, no ripples.
  float churn = 0.0;
  for (int i = 0; i < ${MAX_BULGES}; i++) {
    vec3 b = uBulge[i];
    if (b.z > 0.0) { float q = (p.x - b.x) / (b.z * 1.4); churn += exp(-q * q) * clamp(abs(b.y) / 40.0, 0.0, 1.0); }
  }
  churn = clamp(churn, 0.0, 1.0);
  float rip = ripples(p, 1.0 - u) * smoothstep(60.0, 150.0, band) * (1.0 - churn);
  col *= 1.0 + 0.16 * rip;
  col *= 1.0 - 0.16 * churn * fbm(p * 0.05 + uTime * 2.0);
  col *= 0.95 + 0.1 * hash21(floor(gl_FragCoord.xy));
  // The crest itself catches the low sun.
  col += vec3(0.32, 0.22, 0.1) * exp(-depth / 2.2) * clamp(0.95 - slope * 2.6, 0.2, 1.6);
  gl_FragColor = vec4(dither(col) * alpha, alpha);
}`

const HAZE_FS = `
precision highp float;
uniform vec2 uRes; uniform float uScale; uniform float uAmt; uniform float uTime; uniform float uDir;
uniform float uBase; uniform vec2 uHead; uniform float uSeed;
${NOISE}
void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y * uScale - gl_FragCoord.y) / uScale;
  float d1 = fbm(p * 0.0021 + vec2(-uTime * 0.07 * uDir + uSeed, uTime * 0.012));
  float d2 = fbm(p * 0.0052 + vec2(-uTime * 0.2 * uDir - uSeed, -uTime * 0.03));
  float dens = smoothstep(0.32, 0.85, d1 * 0.62 + d2 * 0.38);
  float low = smoothstep(uRes.y * 0.05, uBase + 10.0, p.y);
  vec2 q = (p - uHead) / vec2(560.0, 340.0);
  float near = exp(-dot(q, q));
  float a = uAmt * (0.05 + dens * (0.4 * low + 0.45 * near));
  // A warm cast over everything, deeper at the bottom: the light of a low desert sun.
  float wash = uAmt * (0.06 + 0.09 * low);
  vec3 dust = vec3(0.88, 0.66, 0.42);
  vec3 tint = vec3(0.72, 0.42, 0.18);
  float A = clamp(a + wash, 0.0, 0.9);
  vec3 col = (dust * a + tint * wash) / max(A, 0.0001);
  col += (vnoise(gl_FragCoord.xy * 0.73) + vnoise(gl_FragCoord.yx * 0.91) - 1.0) / 160.0;
  gl_FragColor = vec4(col * A, A);
}`

const PART_VS = `
attribute vec2 aPos; attribute float aSize; attribute float aAlpha; attribute float aShade; attribute float aKind;
uniform vec2 uRes; uniform float uScale; uniform float uMaxPt;
varying float vAlpha; varying float vShade; varying float vKind;
void main() {
  vAlpha = aAlpha; vShade = aShade; vKind = aKind;
  gl_PointSize = min(aSize * uScale, uMaxPt);
  gl_Position = vec4(aPos.x / uRes.x * 2.0 - 1.0, 1.0 - aPos.y / uRes.y * 2.0, 0.0, 1.0);
}`

const PART_FS = `
precision mediump float;
varying float vAlpha; varying float vShade; varying float vKind;
${NOISE}
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a;
  vec3 col;
  if (vKind > 0.5) {
    // Ragged, not round: noise eats into the cloud from its edge.
    vec2 q = gl_PointCoord * 3.0 + vShade * 41.0;
    float n = vnoise(q) * 0.6 + vnoise(q * 2.3) * 0.4;
    a = smoothstep(0.0, 0.6, exp(-d * d * 2.2) * (0.35 + 1.1 * n) - 0.25) * 0.8 * (1.0 - smoothstep(0.8, 1.0, d));
    col = mix(vec3(0.74, 0.54, 0.34), vec3(0.92, 0.74, 0.5), vShade);
  } else {
    a = 1.0 - smoothstep(0.55, 1.0, d);
    // Lit from the upper left: each grain brighter on that side.
    float lit = 0.75 + 0.45 * clamp((0.5 - gl_PointCoord.x) + (0.5 - gl_PointCoord.y), -0.5, 0.5);
    col = mix(vec3(0.5, 0.32, 0.18), vec3(0.98, 0.8, 0.54), vShade) * lit;
  }
  a *= vAlpha;
  gl_FragColor = vec4(col * a, a);
}`

function compile(gl: WebGLRenderingContext, vs: string, fs: string): WebGLProgram {
  const prog = gl.createProgram()!
  const shaders: WebGLShader[] = []
  // Once linked, or once failed, the shaders are not needed: the program keeps what it uses.
  const release = () => { for (const sh of shaders) { gl.detachShader(prog, sh); gl.deleteShader(sh) } }
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const sh = gl.createShader(type)!
    shaders.push(sh)
    gl.attachShader(prog, sh)
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) ?? 'shader'
      release(); gl.deleteProgram(prog)
      throw new Error(log)
    }
  }
  gl.linkProgram(prog)
  release()
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog) ?? 'link'
    gl.deleteProgram(prog)
    throw new Error(log)
  }
  return prog
}

interface Prog { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null>; a: Record<string, number> }

function program(gl: WebGLRenderingContext, vs: string, fs: string, uniforms: string[], attribs: string[]): Prog {
  const p = compile(gl, vs, fs)
  const u: Prog['u'] = {}, a: Prog['a'] = {}
  for (const n of uniforms) u[n] = gl.getUniformLocation(p, n)
  for (const n of attribs) a[n] = gl.getAttribLocation(p, n)
  return { p, u, a }
}

/** Binds interleaved float attributes `[name, size]` from the current ARRAY_BUFFER. */
function layout(gl: WebGLRenderingContext, prog: Prog, attrs: Array<[string, number]>): void {
  const stride = attrs.reduce((n, [, s]) => n + s, 0) * 4
  let off = 0
  for (const [name, size] of attrs) {
    const loc = prog.a[name]
    if (loc >= 0) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off) }
    off += size * 4
  }
}
function unlayout(gl: WebGLRenderingContext, prog: Prog): void {
  for (const loc of Object.values(prog.a)) if (loc >= 0) gl.disableVertexAttribArray(loc)
}

/** A renderer drawing into `canvas`, or null when this browser gives no WebGL. */
export function createRenderer(canvas: HTMLCanvasElement, scale: number): Renderer | null {
  const context = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true, depth: false, stencil: false })
  if (!context) return null
  const gl: WebGLRenderingContext = context
  const built: Prog[] = []
  const make = (vs: string, fs: string, uniforms: string[], attribs: string[]) => {
    const p = program(gl, vs, fs, uniforms, attribs)
    built.push(p)
    return p
  }
  let body: Prog, maw: Prog, sand: Prog, haze: Prog, part: Prog
  try {
    body = make(BODY_VS, BODY_FS, ['uRes', 'uTime', 'uSand'], ['aPos', 'aTan', 'aV', 'aS', 'aR', 'aPh', 'aRing', 'aSlope'])
    maw = make(QUAD_VS, MAW_FS, ['uRes', 'uOpen', 'uTime', 'uPx', 'uA', 'uB', 'uShow'], ['aPos', 'aUv'])
    sand = make(FULL_VS, SAND_FS, ['uRes', 'uScale', 'uBase', 'uBand', 'uTime', 'uFade', 'uBulge'], ['aPos'])
    haze = make(FULL_VS, HAZE_FS, ['uRes', 'uScale', 'uAmt', 'uTime', 'uDir', 'uBase', 'uHead', 'uSeed'], ['aPos'])
    part = make(PART_VS, PART_FS, ['uRes', 'uScale', 'uMaxPt'], ['aPos', 'aSize', 'aAlpha', 'aShade', 'aKind'])
  } catch (e) {
    // A shader that does not build must not leave a live GL context behind for the scene's life.
    for (const p of built) gl.deleteProgram(p.p)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    throw e
  }
  const maxPt = (gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array)[1] || 64

  const fullBuf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, fullBuf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const bodyBuf = gl.createBuffer(), mawBuf = gl.createBuffer(), partBuf = gl.createBuffer()
  // Two vertices per spine sample: x, y, tx, ty, v, s, r.
  let bodyVerts = new Float32Array(0)
  let phase = new Float32Array(0)
  const mawVerts = new Float32Array(16)

  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

  function fullscreen(prog: Prog) {
    gl.bindBuffer(gl.ARRAY_BUFFER, fullBuf)
    layout(gl, prog, [['aPos', 2]])
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    unlayout(gl, prog)
  }

  function drawHaze(f: Frame, amt: number, seed: number) {
    if (amt <= 0.001) return
    gl.useProgram(haze.p)
    gl.uniform2f(haze.u.uRes, f.w, f.h); gl.uniform1f(haze.u.uScale, scale)
    gl.uniform1f(haze.u.uAmt, amt); gl.uniform1f(haze.u.uTime, f.t); gl.uniform1f(haze.u.uDir, f.dir)
    gl.uniform1f(haze.u.uBase, f.sand); gl.uniform2f(haze.u.uHead, f.hx, f.hy); gl.uniform1f(haze.u.uSeed, seed)
    fullscreen(haze)
  }

  function drawBody(f: Frame) {
    const n = f.spine.count
    if (n < 2) return
    const need = n * 2 * BODY_FLOATS
    if (bodyVerts.length < need) bodyVerts = new Float32Array(need)
    if (phase.length < n * 2) phase = new Float32Array(n * 2)
    const d = f.spine.data
    // Plates are sized by the girth, but never smaller than the tail's: through the rounded tips
    // they keep their size instead of crowding into a hatch. Their phase is the running sum of
    // length over plate size, so a plate stays one plate wherever the girth changes.
    let maxR = 0
    for (let j = 0; j < n; j++) maxR = Math.max(maxR, d[j * SPINE_STRIDE + 4])
    const floor = maxR * PLATE_FLOOR
    for (let j = 0; j < n; j++) {
      const i = j * SPINE_STRIDE
      const ring = 0.42 * Math.max(d[i + 4], floor)
      phase[j * 2 + 1] = ring
      phase[j * 2] = j === 0 ? d[i + 5] / ring : phase[(j - 1) * 2] + (d[i + 5] - d[i + 5 - SPINE_STRIDE]) / ring
    }
    // Tail first, so the front of the worm paints over the back where the body overlaps itself.
    let k = 0
    for (let j = n - 1; j >= 0; j--) {
      const i = j * SPINE_STRIDE
      const x = d[i], y = d[i + 1], tx = d[i + 2], ty = d[i + 3], s = d[i + 5]
      const r = Math.max(d[i + 4], 0.5)
      // How fast the girth changes along the body: what makes a rounded tip read as a dome.
      const a = Math.max(0, j - 1), b = Math.min(n - 1, j + 1)
      const ds = d[b * SPINE_STRIDE + 5] - d[a * SPINE_STRIDE + 5]
      const slope = ds > 0 ? Math.max(-8, Math.min(8, (d[b * SPINE_STRIDE + 4] - d[a * SPINE_STRIDE + 4]) / ds)) : 0
      const nx = -ty, ny = tx
      // One and a half pixels past the radius, for the edge's own antialiasing.
      const e = r + 1.5, v = e / r
      for (let side = 1; side >= -1; side -= 2) {
        bodyVerts[k++] = x + nx * e * side; bodyVerts[k++] = y + ny * e * side
        bodyVerts[k++] = tx; bodyVerts[k++] = ty
        bodyVerts[k++] = v * side; bodyVerts[k++] = s; bodyVerts[k++] = r
        bodyVerts[k++] = phase[j * 2]; bodyVerts[k++] = phase[j * 2 + 1]; bodyVerts[k++] = slope
      }
    }
    gl.useProgram(body.p)
    gl.uniform2f(body.u.uRes, f.w, f.h); gl.uniform1f(body.u.uTime, f.t); gl.uniform1f(body.u.uSand, f.sand)
    gl.bindBuffer(gl.ARRAY_BUFFER, bodyBuf)
    gl.bufferData(gl.ARRAY_BUFFER, bodyVerts.subarray(0, need), gl.DYNAMIC_DRAW)
    layout(gl, body, [['aPos', 2], ['aTan', 2], ['aV', 1], ['aS', 1], ['aR', 1], ['aPh', 1], ['aRing', 1], ['aSlope', 1]])
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, n * 2)
    unlayout(gl, body)
  }

  function drawMaw(f: Frame) {
    const m = f.maw
    const ext = 1.55
    let k = 0
    for (const [u, v] of MAW_CORNERS) {
      mawVerts[k++] = m.x + (m.ax * u + m.bx * v) * ext
      mawVerts[k++] = m.y + (m.ay * u + m.by * v) * ext
      mawVerts[k++] = u * ext; mawVerts[k++] = v * ext
    }
    gl.useProgram(maw.p)
    gl.uniform2f(maw.u.uRes, f.w, f.h); gl.uniform1f(maw.u.uOpen, m.open); gl.uniform1f(maw.u.uTime, f.t)
    // Shut, the snout is the body's own; the face fades in as the lobes part.
    const show = Math.min(1, Math.max(0, (m.open - 0.14) / 0.2))
    if (show <= 0) return
    gl.uniform1f(maw.u.uShow, show)
    gl.uniform1f(maw.u.uPx, 1 / Math.max(4, Math.min(Math.hypot(m.ax, m.ay), Math.hypot(m.bx, m.by))))
    const la = Math.hypot(m.ax, m.ay) || 1, lb = Math.hypot(m.bx, m.by) || 1
    gl.uniform2f(maw.u.uA, m.ax / la, m.ay / la); gl.uniform2f(maw.u.uB, m.bx / lb, m.by / lb)
    gl.bindBuffer(gl.ARRAY_BUFFER, mawBuf)
    gl.bufferData(gl.ARRAY_BUFFER, mawVerts, gl.DYNAMIC_DRAW)
    layout(gl, maw, [['aPos', 2], ['aUv', 2]])
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    unlayout(gl, maw)
  }

  function drawSand(f: Frame) {
    gl.useProgram(sand.p)
    gl.uniform2f(sand.u.uRes, f.w, f.h); gl.uniform1f(sand.u.uScale, scale)
    gl.uniform1f(sand.u.uBase, f.sand); gl.uniform1f(sand.u.uTime, f.t); gl.uniform1f(sand.u.uFade, f.sandFade)
    // How far the sand has risen: every dune grows with it, so none shows before the sand does.
    gl.uniform1f(sand.u.uBand, Math.max(0, f.h + 12 - f.sand))
    gl.uniform3fv(sand.u.uBulge, f.bulges)
    fullscreen(sand)
  }


  function drawParticles(f: Frame) {
    if (!f.particleCount) return
    gl.useProgram(part.p)
    gl.uniform2f(part.u.uRes, f.w, f.h); gl.uniform1f(part.u.uScale, scale); gl.uniform1f(part.u.uMaxPt, maxPt)
    gl.bindBuffer(gl.ARRAY_BUFFER, partBuf)
    gl.bufferData(gl.ARRAY_BUFFER, f.particles.subarray(0, f.particleCount * STRIDE), gl.DYNAMIC_DRAW)
    layout(gl, part, [['aPos', 2], ['aSize', 1], ['aAlpha', 1], ['aShade', 1], ['aKind', 1]])
    gl.drawArrays(gl.POINTS, 0, f.particleCount)
    unlayout(gl, part)
  }

  return {
    draw(f) {
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      drawHaze(f, f.haze * 0.7, 3.1)
      drawBody(f)
      if (f.spine.count) drawMaw(f)
      drawSand(f)
      drawParticles(f)
      drawHaze(f, f.haze * 0.55, 11.7)
    },
    dispose() {
      for (const b of [fullBuf, bodyBuf, mawBuf, partBuf]) gl.deleteBuffer(b)
      for (const p of [body, maw, sand, haze, part]) gl.deleteProgram(p.p)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    },
  }
}
