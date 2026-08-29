# Smoke & Ember: art and rendering bible for 3D Connect 4

**Version 1.0. This is the contract.** Engineers implement against the numbers in this document. Where a number is given, it is not a suggestion; deviate only with art director sign-off. Where a technique is named, use that technique or escalate.

The concept in one sentence: a Connect 4 set re-engineered as a premium desk object, smoked acrylic and bead-blasted aluminum, lacquered ceramic discs in burnt sienna and petrol teal, shot on a basalt slab in a dark photo studio with one enormous softbox. It should read as an Apple product hero shot that happens to be playable.

---

## 0. Global rules

**Stack and pins.** Three.js >= r167 (needed for `scene.environmentIntensity`, `AgXToneMapping`, `transmissionResolutionScale`). `postprocessing` (pmndrs) >= 6.35 for the effect chain. `n8ao` for ambient occlusion. No other rendering dependencies. No downloaded textures, no downloaded HDRs, no downloaded fonts. The only bundled binary asset permitted is one 128 x 128 tileable blue-noise texture (under 4 KB) for film grain and dithering; everything else is procedural.

**Units and color.** World units are meters. All hex codes in this document are sRGB; author them via `new Color().setHex(0x...)` with default color management on (`outputColorSpace = SRGBColorSpace`, lighting computed in linear). Physical light mode (Three.js default since r155) is assumed; do not enable legacy lights.

**Renderer config.**

```
antialias: false            // AA comes from composer MSAA, section 4
powerPreference: "high-performance"
toneMapping: AgXToneMapping (fallback ACESFilmic, see 4.1)
toneMappingExposure: 1.15
shadowMap.enabled: true
shadowMap.type: VSMShadowMap
transmissionResolutionScale: 0.5
pixelRatio: min(devicePixelRatio, 2)
```

**Quality tiers.** Tier A is M1 and later, and Apple Silicon Macs. Tier B is A12 through A15 iPads. Detect by timing the first 120 frames; if mean frame time exceeds 12 ms, drop to Tier B. Tier B changes, and only these: transmission replaced by sorted alpha blending on the board panels (opacity 0.5, `depthWrite: false`), DoF disabled except during the win sequence, composer MSAA off and SMAA on, N8AO intensity halved, pixel ratio capped at 1.5. Nothing else degrades.

**Performance budget.** Under 90 draw calls, under 450k triangles, under 48 MB texture memory. 60 fps sustained on Tier A during a drop with coach overlay active.

**The taboo list.** These disqualify a build on sight: lens flares, god rays, confetti or particle spam, neon outline shaders, scanlines or "hologram" stripes, pure #000000 or #FFFFFF anywhere in the frame, photographic skyboxes, infinite mirror floors, any hue not in the section 0 palette, any font that is not the system stack.

**Palette (the only hues in the product).**

| Token | Hex | Role |
|---|---|---|
| `ember` | `#CE5A32` | Player 1 disc body |
| `petrol` | `#0F6068` | Player 2 disc body |
| `ember-glow` | `#FF9666` | P1 overlay/emissive elements |
| `petrol-glow` | `#53D7DB` | P2 overlay/emissive elements |
| `gold` | `#FFD9A8` | Win sequence only. Never elsewhere. |
| `pewter` | `#ADB9C6` | Loss sequence accent |
| `starlight` | `#D6CFC4` | Aluminum frame |
| `smoke` | `#6E7A82` | Acrylic attenuation color |
| `basalt` | `#23262A` | Tabletop |
| `void-low` / `void-high` | `#101114` / `#1D2024` | Backdrop gradient |
| `pool` | `#2A2521` | Warm backdrop pool behind board |
| `ink` / `ink-dim` | `#F2F1EE` / `#9BA0A6` | UI text |

---

## 1. Scene concept and staging

### 1.1 The set

A single monolithic slab of honed basalt, the tabletop, floats in a dark studio void. No walls, no horizon line, no props. The board sits dead center on a low aluminum plinth. Behind it, the backdrop is a smooth vertical gradient from `void-low` at the bottom to `void-high` at 60 degrees elevation, built as an inverted 8 m radius sphere with a vertex-shader gradient (never a photo, never visible banding: apply blue-noise dither at 1/255 in the gradient shader). Centered behind the board, add a radial warm pool, a 1.6 m radius soft radial gradient of `pool` at 10 percent opacity peak, additively on the backdrop, so the board's dark silhouette separates from the dark void. That separation is what makes it photography instead of a screensaver.

### 1.2 Object dimensions (meters in code, mm here)

| Element | Dimension |
|---|---|
| Disc | diameter 42, thickness 9, edge fillet 1.5, two concentric lathed grooves at r = 12 and r = 17, groove depth 0.6, width 1.4 |
| Cell pitch | 46 x 46, grid 7 x 6 |
| Front/back panel holes | diameter 36 (disc overlaps hole by 3 mm all around) |
| Acrylic panels | 2 sheets, 6 thick, interior gap 11 |
| Board envelope | 366 W x 330 H x 38 D including frame rails |
| Frame rails | 8 x 38 section, chamfer 0.8 on every edge |
| Feed mouths | each column's top slot flares with a 15 degree chamfer, 6 deep |
| Plinth | 420 x 140 x 22, same aluminum |
| Tabletop slab | 2.4 x 1.2 x 0.06, top surface at y = 0 |

Rule with no exceptions: every edge in the scene carries a fillet or chamfer of at least 0.5 mm. Zero-radius edges cannot catch light and are the single fastest way to look like a video game. Disc silhouettes use at least 96 radial segments.

### 1.3 Camera

- `PerspectiveCamera`, vertical FOV **22 degrees** (62 mm full-frame equivalent; the compression is the product-photography look, and 35 mm-style wide angles are banned).
- Rest position `(0.13, 0.36, 1.22)`, target `(0, 0.17, 0)`. That yields 6.1 degrees yaw off dead-center and 8.8 degrees downward pitch, so you see the board face, a sliver of the right rail depth, and the tabletop plane with reflections. Board occupies about 68 percent of frame height.
- Aspect safety: on narrow viewports (aspect < 1.2), fit by horizontal FOV instead so the board never crops; recompute `fov` per resize.

### 1.4 Camera behavior on interaction

The camera is on a tripod, not a turntable. There is no free orbit, ever.

- Pointer parallax orbits about the target at fixed radius 1.24 m. Limits from rest pose: yaw plus/minus 5 degrees, pitch plus 3 / minus 2 degrees. Pointer position maps linearly to the target angle; the camera chases it with a critically damped spring, `k = 60, c = 15.5, m = 1` (about 350 ms to settle).
- iPad device tilt adds up to plus/minus 3 degrees via DeviceOrientation, through the same spring.
- Idle breathing: plus/minus 0.2 degrees yaw, 14 s sine period. Disabled when `prefers-reduced-motion` is set.
- Intro move on load: start at yaw +14 degrees, pitch +6, radius 1.55, hold 200 ms, then 1400 ms to rest pose on `cubic-bezier(0.16, 1, 0.3, 1)`.
- Scripted moves (win framing, menu) use `cubic-bezier(0.33, 0, 0.12, 1)`, 900 ms, and always move radius, yaw, pitch together; never animate one axis alone.

---

## 2. Lighting rig

One warm softbox key, a cool ambient fill, a hard cool rim. Warm key against cool rim is the whole color story of the lighting.

### 2.1 Analytic lights

| Light | Type | Size | Position (m) | Aim | Color | Intensity |
|---|---|---|---|---|---|---|
| Key | `RectAreaLight` | 1.2 x 1.8 | (-0.85, 1.35, 0.95) | at target | `#FFF1E3` | 9.0 |
| Fill | `RectAreaLight` | 2.5 x 2.5 | (1.6, 0.9, 0.6) | at target | `#D8E3EE` | 2.2 |
| Rim | `RectAreaLight` | 0.25 x 1.6 (vertical strip) | (1.15, 0.55, -1.25) | at target | `#EAF1FF` | 22.0 |
| Shadow proxy | `DirectionalLight` | n/a | along key axis | at origin | `#FFF1E3` | 1.6 |

Treat the ratios as canonical (key : fill : rim = 1 : 0.24 : 2.4). If overall brightness needs retuning, touch `toneMappingExposure` only.

### 2.2 Shadows

`RectAreaLight` cannot cast shadows in Three.js, hence the shadow proxy directional aligned with the key's center axis. Settings: `mapSize 2048 x 2048`, VSM with `radius 8`, `blurSamples 16`, `bias -0.0002`, `normalBias 0.02`, ortho frustum tightly fit to plus/minus 0.45 m around the board. VSM gives the wide, softbox-like penumbra; verify the penumbra visibly widens with occluder distance (Definition of Done item 5).

Contact grounding: a 512 x 512 canvas-generated radial-gradient shadow decal (black, gaussian falloff, gamma 1.6) under the plinth footprint scaled 1.15x, multiply-blended on the tabletop at opacity 0.5. N8AO (section 4) handles per-disc contact darkening inside the board.

### 2.3 Procedural environment (IBL)

No HDR files. Build a `StudioEnvironment` scene, render once through `PMREMGenerator` at boot (256 cube), assign to `scene.environment`, then dispose the source scene. Contents:

- Room: 4 x 3 x 4 m box, interior albedo `#0C0D0F`, `side: BackSide`.
- Key card: 1.2 x 1.8 plane, emissive `#FFF1E3`, intensity 20, at the key light's position and orientation.
- Fill card: 2.5 x 2.5 plane, emissive `#D8E3EE`, intensity 4.5, at the fill's position.
- Rim card: 0.3 x 1.8 plane, emissive `#EAF1FF`, intensity 45, at the rim's position.
- Horizon card: 3.0 x 0.6 plane behind the camera at y = 0.4, emissive `#35302A`, intensity 0.8. This is what puts a long warm streak in the tabletop sheen.

`scene.environmentIntensity = 0.55`. The analytic lights model the form; the environment exists so every glossy surface reflects rectangles. Window-shaped highlights on the discs are the number one "expensive" tell and are a hard acceptance criterion.

---

## 3. Materials

All hero materials are `MeshPhysicalMaterial`. Every procedural texture below is generated once at boot into canvases or `DataTexture`s; total generation budget 150 ms on Tier A.

### 3.1 Discs, "lacquered ceramic"

The feel brief is kiln ceramic under a piano-lacquer clearcoat: a satin colored body with a glassy top layer. Not toy plastic, not bare metal.

| Parameter | Ember (P1) | Petrol (P2) |
|---|---|---|
| `color` | `#CE5A32` | `#0F6068` |
| `roughness` | 0.34 | 0.34 |
| `metalness` | 0.0 | 0.0 |
| `clearcoat` | 1.0 | 1.0 |
| `clearcoatRoughness` | 0.12 | 0.12 |
| `ior` | 1.5 | 1.5 |
| `specularIntensity` | 1.0 | 1.0 |
| `sheen` / `iridescence` / `transmission` | 0 / 0 / 0 | 0 / 0 / 0 |
| `envMapIntensity` | 1.0 | 1.0 |

These two hexes were chosen for a grayscale luminance gap of about 16 L* so the colors survive every common color-vision deficiency and a grayscale screenshot. Do not "fix" them toward red and yellow.

Micro-detail, all procedural:

- Orange peel: 512 x 512 simplex-noise height field, feature size about 0.5 mm on the disc, converted to a normal map, applied as `clearcoatNormalMap` with `clearcoatNormalScale (0.06, 0.06)`. This is what makes lacquer read as lacquer; highlights should wobble slightly as the camera parallaxes.
- Body speckle: `roughnessMap` from 2-octave value noise, plus/minus 0.04 around base roughness, feature size 0.3 mm.
- Smudge pass: 3-octave Perlin at very low frequency (2 features per disc face) added to `clearcoatRoughness` in patches of +0.05. Visible only when a highlight sweeps across; at rest it must be invisible. This is the fingerprint note, and subtlety is the entire point.
- No scratches, no edge grime. This object is new. Wear is expressed only as a 0.85x albedo AO ring baked into the lathed grooves (multiply the groove interior in the generated albedo map).

### 3.2 Board, smoked acrylic in a machined frame

Decision: twin smoked-acrylic panels captured in a bead-blasted warm-anodized aluminum frame. Justification in one line: glass-and-metal is the material language of the hardware this game ships on, and smoke keeps 42 discs legible while making the object engineered rather than toylike.

Acrylic panels:

```
color: #FFFFFF
transmission: 1.0
thickness: 0.006          // matches real panel depth, meters
attenuationColor: #6E7A82
attenuationDistance: 0.02
roughness: 0.06
metalness: 0.0
ior: 1.49                 // PMMA
clearcoat: 0.0
dispersion: 0.0
```

Discs seen through the front panel pick up a cool haze and slight refraction at grazing angles. That veiling is desirable; do not compensate it away. Tier B swaps this material for `transparent: true, opacity: 0.5, depthWrite: false` with manual render order (inner discs, back panel, discs, front panel).

Frame, plinth, feed mouths:

```
color: #D6CFC4            // "starlight" warm anodize
metalness: 1.0
roughness: 0.36
envMapIntensity: 1.0
anisotropy: 0.0           // bead-blasted, isotropic; do not brush it
```

Roughness map: fine white-noise variation plus/minus 0.03 at 0.2 mm feature size (bead blast). The 0.8 mm chamfers are where the rim light lives; verify a continuous bright chamfer line down the right rail in the rest pose.

### 3.3 Tabletop, honed basalt with a sealed sheen

```
color: #23262A
roughness: 0.38
metalness: 0.0
clearcoat: 0.25
clearcoatRoughness: 0.35
envMapIntensity: 0.5
```

Albedo: 1024 x 1024 canvas speckle, base `#23262A`, per-pixel brightness variance 2 percent, plus sparse lighter mineral flecks (`#3A3E43`, about 400 flecks, 1 to 3 px). Normal map derived from the same field at scale 0.15. The clearcoat layer gives a soft, stretched reflection of the board and the horizon card; that blurry reflection under the object is doing the "product on seamless" work. Optional Tier A garnish: a half-resolution `Reflector` on the slab mixed at 12 percent with 2-pass blur; cut it the moment it costs frames.

### 3.4 Ghost and overlay materials

Coach and hover elements (section 7) use a custom additive fresnel shader, not standard materials: owner glow color, `blending: AdditiveBlending`, `depthWrite: false`, opacity = base x (0.10 center to 0.45 at rim, fresnel power 2.5), plus a 1-octave time-scrolling noise shimmer at plus/minus 8 percent opacity, period 3 s. No scanlines, no hexagons, no sci-fi.

---

## 4. Post-processing stack

Order is exact. All effects run pre-tonemap on half-float buffers; tone mapping is the final operation. The stack must pass the "cheap demo" A/B tests in section 9. If any single effect is visible as an effect in a still frame, it is tuned too hot.

1. **Render pass.** HalfFloatType target. Tier A: composer `multisampling: 4` (WebGL2 MSAA, the primary AA). Tier B: multisampling 0.
2. **Ambient occlusion, N8AO.** `aoRadius 0.03` (world meters), `intensity 2.0`, `distanceFalloff 0.1`, half-resolution with its built-in denoise and upsample. AO darkens indirect only; it must be visible as grounding inside the board slots and between disc and slot floor, never as gray halos around silhouettes.
3. **Bloom.** Mipmap-blur bloom, `luminanceThreshold 1.0` (HDR-only, nothing below 1.0 ever blooms), `intensity 0.12`, `radius 0.55`. Its only job is softening specular cores and the win filament. If the UI or a disc body blooms, it fails review.
4. **Depth of field.** `DepthOfFieldEffect` with world-space focus. `worldFocusDistance` tracks the camera-to-target distance (1.24 m at rest) every frame. Play state: `worldFocusRange 0.8`, `bokehScale 1.0`, so the entire board is inside focus and DoF touches only the deep backdrop. Win and menu states: `worldFocusRange 0.12`, `bokehScale 3.2` (an f/2.8 metaphor). Transition between states over 600 ms on the camera easing curve. DoF never blurs any part of the board during play; that is a hard rule.
5. **Chromatic aberration.** `offset 0.0004`, `radialModulation: true`, `modulationOffset 0.5`. Sub-pixel at center, about half a pixel at corners. At review zoom it should be deniable.
6. **Vignette.** `offset 0.3`, `darkness 0.45`. Measured corner falloff must stay at or under 0.3 EV.
7. **Film grain.** Custom effect sampling the bundled 128 x 128 blue noise, animated by an R2-sequence UV offset per frame. Luminance-weighted amplitude: 0.018 at mid-gray, tapering to 0.006 in deep shadows and highlights. White-noise `NoiseEffect` is banned; it is the signature of the cheap demo.
8. **Tone mapping.** AgX, exposure 1.15. AgX is chosen specifically because it rolls the saturated ember and petrol highlights toward white without hue-skewing to neon. Fallback on r < 160 only: ACESFilmic at exposure 1.05.
9. **SMAA (Tier B only).** Preset HIGH, replacing MSAA. Never run both.

No SSR pass, no god rays, no LUT beyond the above. If a colorist pass is ever wanted, it happens by editing this document first.

---

## 5. Motion and animation language

The feel is weighty ceramic. Objects have mass, arrive with confidence, and stop dead with a tiny damped remainder. Nothing floats, nothing overshoots by more than 2 percent, nothing wiggles for attention.

### 5.1 Named curves and springs

| Name | Definition | Used for |
|---|---|---|
| `gallery` | `cubic-bezier(0.33, 0, 0.12, 1)`, 900 ms | scripted camera moves |
| `arrive` | `cubic-bezier(0.16, 1, 0.3, 1)`, 1400 ms | intro camera |
| `ui-in` | `cubic-bezier(0.32, 0.72, 0, 1)`, 240 ms | panels, banners entering |
| `ui-out` | `cubic-bezier(0.4, 0, 1, 1)`, 160 ms | panels leaving |
| `hover` | `cubic-bezier(0.25, 0.46, 0.45, 0.94)`, 120 ms in, 200 ms out | hover fades, rings |
| `chase` | spring k = 60, c = 15.5, m = 1 (critical) | camera parallax |
| `nudge` | spring k = 170, c = 26, m = 1 | landing camera settle |

### 5.2 Disc drop (simulated, not tweened)

- Integrate real gravity: g = 9.81 m/s^2, initial downward velocity 0.4 m/s (the release push). A full-height drop (0.30 m) lands in about 247 ms. Do not slow this down; real gravity at real scale is what reads as weight.
- Impact: restitution 0.18 on first bounce (8 mm rebound from full height), each subsequent bounce multiplies restitution by 0.45. Kill velocity below 0.05 m/s. Everything settled inside 480 ms.
- On impact the disc gets a roll oscillation, plus/minus 1.2 degrees decaying over 300 ms. No squash and stretch, ever; ceramic does not squash.
- Discs already in the column receive nothing. They are heavy; they do not react.
- Camera: for drops of 4 or more cells, a 1.2 mm vertical settle through the `nudge` spring, about 180 ms. Shorter drops get no camera response. No screen shake in any other situation.
- Timing note for the audio pass: the impact transient lands on the exact physics-contact frame.

### 5.3 Aiming and hover

- Pointer or drag over a column: ghost disc (section 3.4 material, owner color) appears in the feed mouth, fade in 120 ms on `hover`. The ghost is perfectly still. Stillness is the weight cue; a bobbing ghost is the toy version.
- Ghost slides between columns in 90 ms, ease-out, snapping to column centers.
- The hovered column's six hole rims get a hairline stroke, `ink` at 8 percent; the landing cell's rim at 20 percent.
- Touch model: drag to aim, release to drop; a plain tap aims and drops in one gesture. Interaction details beyond this belong to the UX spec.

### 5.4 Rematch purge

Board reset is physical, 900 ms total: the bottom gate rail slides open over 250 ms (`ui-in` curve), all discs fall under gravity, fading out over the 150 ms after they pass the tabletop plane, with staggered soft impact transients; gate slides shut, 250 ms. No dissolves, no shuffles.

---

## 6. Win, loss, draw

One idea, executed slowly and confidently: the winning line becomes the only light source that matters. No confetti, no fireworks, no repeats.

### 6.1 Win sequence (timeline from final disc contact)

| t (ms) | Event |
|---|---|
| 0 | Final disc lands with the standard physics and settle. |
| 120 | House lights dim: backdrop, table, and non-winning discs desaturate 15 percent and darken 18 percent over 400 ms (uniform-driven, `gallery` easing). |
| 250 | The four winning discs ignite in cascade along the line direction, 90 ms stagger: each ramps `emissive` from black to its own body color times 2.2 over 350 ms, then breathes 0.85 to 1.0 at a 1.8 s period. |
| 400 | The core line: a 3 mm rounded-cap cylinder of `gold` `#FFD9A8`, emissive intensity 3.0, draws itself through the four disc centers over 450 ms (shader clip along length). It should just tickle bloom, a halo of a few pixels, no more. |
| 700 | Camera: 7 percent dolly-in plus up to 3 degrees orbit toward the line's normal, 1200 ms on `gallery`; DoF shifts to win state (`worldFocusRange 0.12`, `bokehScale 3.2`) with the winning line held on the focus plane. |
| 900 | One particle gesture: 40 to 60 ember motes rise from the four discs. Size 1 to 2 mm, additive, owner glow color at 60 percent, upward 0.05 m/s with gentle curl noise, lifetime 1.2 s, one emission only. |
| 1100 | Result banner enters (`ui-in`). Copy is quiet: "Ember takes it." |

Total choreography under 2.5 s, then the scene holds: dimmed house, breathing line, tightened focus. It should be worth screenshotting.

### 6.2 Loss (human loses to AI)

Same structure, cooler temperament. The AI's line ignites in its own body color; the core line uses `pewter` `#ADB9C6` instead of gold. The player's discs shift roughness +0.15 and desaturate 30 percent over 800 ms, clay going cold. Key light color lerps 300 K cooler, vignette darkness +0.06. No slow-motion, no sad trombone staging, no taunting copy. "Petrol takes it." Dignity is the direction.

### 6.3 Draw

Both colors desaturate 20 percent over 600 ms, lighting stays neutral, camera pulls back 4 percent. Banner: "Nobody yields." Gold does not appear.

---

## 7. The teaching overlay (Easy mode coach)

Purpose: children learn to see lines. The overlay must show 2-in-a-row and 3-in-a-row potential for both players without turning the board into a light show. The design discipline comes from three constraints: only two hues (the players' own glow colors; urgency is never a third color), only three geometric elements, and a hard cap on simultaneous glow.

### 7.1 Threat taxonomy (drives presentation)

A "line" is 2 or 3 same-color discs inside some 4-window whose remaining cells are empty. A completion cell is "live" if a disc dropped in that column lands there right now.

| Class | Meaning | Priority |
|---|---|---|
| A1 | Current player's 3-line with a live completion cell (win now) | 1 |
| A2 | Opponent's 3-line with a live completion cell (block now) | 2 |
| A3 | Any 3-line whose completion cell is not yet live | 3 |
| B1 | Current player's 2-line with at least one live growth cell | 4 |
| B2 | Opponent's 2-line with a live growth cell | 5 |

Dead lines (no completable window) get nothing, ever.

### 7.2 The three elements

**Ghost disc** (section 3.4 fresnel material, owner glow color) rendered in the completion cell's resting slot position. Class A1/A2 only. It pulses: on-screen opacity 0.22 to 0.40, scale 0.98 to 1.00, period 1.2 s, sine. An open-ended three (two live completion cells) gets a ghost in both cells and is the single loudest thing the coach ever shows; that is deliberate, open threes should feel dangerous. If two different lines complete in the same cell for both players, split the ghost: upper half ember-glow, lower half petrol-glow.

**Line filament**, a 2 mm additive tube threading the existing discs of the line, owner glow color, rendered inside the board.

- Class A (any 3-line): on-screen opacity 0.45, with a slow luminance flow along its length at 0.4 UV/s. Open threes: 0.60 and 0.8 UV/s.
- Class B: opacity 0.14, static, no flow.

**Landing ring**, a flat shader-drawn annulus on the front panel face around the completion hole. Class A: double stroke, inner ring r 19 to 20 mm, outer 20.7 to 21.5 mm, opacity 0.5, pulsing in phase with its ghost. Class B: single hairline, r 20 to 20.8 mm, opacity 0.18, no pulse. Urgency is therefore encoded three ways at once (brightness, motion, double stroke), so it survives colorblindness and screenshots.

### 7.3 Staging rules (the noise budget)

- Default view, coach on: all class A treatments show (in practice 0 to 3). Class B shows filaments only, and only for the player whose turn it is, at most the 2 highest-value ones. Everything else stays dark.
- Column hover or touch-hold reveals the full local picture: every line passing through that column's landing cell lights to class-A filament brightness in its owner's color for the duration of the hover. This is the "what does playing here touch" lesson and it is the coach's best teaching moment.
- Hard cap at any instant: 3 filaments plus 2 ghost cells plus their rings. When over budget, drop by ascending priority. Never fade two overlapping filaments into a blended color; offset their tubes 3 mm in depth.
- All pulses share the 1.2 s period but each element gets a hashed phase offset, so the board shimmers rather than throbbing in unison.
- Coach chip cycles Off / Hints (class A only) / Full (rules above). Easy mode defaults to Full.
- `prefers-reduced-motion`: all pulsing and flow freezes at the midpoint values; nothing else changes.
- Gold is never used here. The coach speaks in the players' own colors; gold stays reserved for the win.

### 7.4 Rendering technique

Overlay elements live inside slots, behind smoked panels, so a naive additive pass either vanishes behind the transmission buffer or pastes on top like a sticker. Canonical approach: a dedicated overlay pass after the main render, with scene depth bound. Each overlay fragment depth-tests with bias; where it lies behind panel geometry it multiplies its color by 0.45 (the smoke dim) instead of discarding. All opacities in 7.2 are final on-screen values after that dim; the engineer calibrates raw values to hit them. Tier B (alpha panels) can render overlays in the sorted transparent queue directly.

---

## 8. UI and typography

### 8.1 Type

```
font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display",
             "SF Pro Text", "Helvetica Neue", Arial, sans-serif;
```

| Style | Size/leading (pt) | Weight | Notes |
|---|---|---|---|
| Banner ("Ember takes it.") | 34/41 | 600 | letter-spacing -0.4 |
| Title | 28/34 | 600 | |
| Headline | 17/22 | 600 | buttons, chip labels |
| Body | 17/22 | 400 | |
| Caption | 13/18 | 400 | color `ink-dim` |
| Micro label | 11/13 | 500 | uppercase, letter-spacing +0.6; the only uppercase in the product |

Numerals in clocks and counters use `font-variant-numeric: tabular-nums`. Text color is `ink` `#F2F1EE`, never pure white; secondary `ink-dim` `#9BA0A6`. Copy voice is sentence case, short, and calm.

### 8.2 Panels

UI glass matches the board's acrylic so the interface and the object feel machined from one kit:

```
background: rgba(18, 20, 23, 0.55);
backdrop-filter: blur(24px) saturate(1.4);
border: 1px solid rgba(255, 255, 255, 0.08);
border-top-color: rgba(255, 255, 255, 0.14);   /* top-lit edge */
border-radius: 16px;
box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
```

The scene must remain readable-but-diffuse through a panel. If `backdrop-filter` is unavailable, fall back to `rgba(18,20,23,0.85)`; never an opaque gray rectangle.

Accents: contextual UI (turn capsule, coach chip states) uses the relevant player color at full strength for a 3 px indicator or fill, with `ink` text. `gold` never appears in idle UI.

### 8.3 Layout, spacing, touch

- Spacing scale: 4, 8, 12, 16, 24, 32, 48 pt. Nothing off-scale.
- Chrome is minimal: settings (top-left, 44 x 44), coach chip (top-right), turn capsule (bottom center, 52 pt tall). Nothing else on screen during play.
- Safe areas: every anchored element pads by `max(16px, env(safe-area-inset-*))`.
- Touch targets: 44 x 44 pt minimum everywhere, including the invisible full-height column hit zones, which must each be at least 44 pt wide at the smallest supported layout (1024 x 768 logical); at that size columns render about 60 pt, so verify rather than assume.
- Hover is an enhancement only; every hover reveal (column inspection included) has a touch-hold equivalent.

---

## 9. Definition of done

Binary checks, each verifiable from screenshots of a Tier A build (items 17 and 18 from a device run). All 18 must pass.

1. Disc highlights show rectangular, window-shaped softbox reflections, not point sparkles.
2. At 200 percent zoom, no polygonal faceting on any disc rim or hole edge.
3. Every visible edge carries a lit chamfer or fillet; zero razor edges anywhere in frame.
4. Discs seen through the front panel are visibly hazed and cool-tinted by the smoke, and refraction is visible at a grazing camera angle.
5. Shadow penumbra visibly widens with occluder distance; no uniform hard-edged shadow, no gap between object and shadow.
6. Contact darkening is present under the plinth and inside occupied slots (AO on, grounded).
7. Histogram: no pixel below 4/255; pixels at 255 are confined to specular cores and the win filament, under 1 percent of the frame.
8. Saturated disc highlights roll toward white with no hue shift to neon (AgX confirmed by a red-to-white gradient on the ember disc's hot spot).
9. A/B toggling bloom changes only specular cores and the win filament; no halo on UI, disc bodies, or frame.
10. In play state the entire board is in focus; in win state the backdrop is measurably defocused while the winning line is sharp.
11. No stair-stepping on frame rails or overlay filaments in a 100 percent still.
12. Film grain is visible at 400 percent zoom on midtones, invisible at normal viewing, and two consecutive frames differ (animated).
13. Corner vignette falloff is at most 0.3 EV.
14. A grayscale conversion still distinguishes the two disc colors (luminance gap at least 12 L*).
15. With coach in Full mode on a busy midgame board, at most 5 luminous overlay elements are lit, and any class A element is unmistakably dominant over class B in the same shot.
16. `#FFD9A8` gold appears in no screenshot except during a win sequence.
17. UI panels show true backdrop blur with a 1 px hairline border, and all tap targets, column zones included, measure at least 44 x 44 pt on device.
18. At every parallax extreme the backdrop fills the frame completely, with no visible gradient banding, seams, or void edges; and with `prefers-reduced-motion` set, all pulsing, drift, and motes are static while the board remains fully readable.

---

Final note to the build team. The order of operations matters: get the materials and lighting rig signed off against items 1 through 8 before any post-processing is written, because a correct lighting rig with zero post beats a weak rig with all nine passes every time. Post is seasoning. The softbox is the meal.
