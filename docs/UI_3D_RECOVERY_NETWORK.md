# Velora — Recovery Network (the 3D hero)

Status: **delivered** on `feat/ui-redesign-dark-purple`. Scope: the decorative
WebGL scene on the public landing hero, its host component, quality tiers,
fallbacks and tests.

The scene carries no patient data, no medical records, no identifiers and no API
response. It is a brand visualization of connected recovery care, and every
element is generated locally from a fixed seed.

---

## 1. Concept

A softly glowing care core sits inside three tilted orbits. The orbits are closed
pathways of nodes — patients, clinicians and recovery milestones are *represented*
by position and connection, never by a label. Sparse cross-orbit links show the
care team working together; six spokes anchor the pathways to the core. Small
signals travel along real edges, so the movement reads as information moving
through care, not as ambient particles.

| Visual | Meaning |
| --- | --- |
| Bright faceted core | the person at the centre of recovery |
| Three orbits | the phases of a recovery journey |
| Nodes | patients, clinicians, milestones (abstract, unlabelled) |
| Ring paths | the care pathway a person actually follows |
| Cross-orbit links | clinical collaboration between phases |
| Signals on edges | approved information moving along a pathway |
| Slow rotation + breathing | calm progress, not urgency |

Deliberately absent: medical crosses, DNA helices, flashing, neon, 3D text,
random particle fields, downloaded models or textures.

## 2. Placement

| Surface | Uses the scene |
| --- | --- |
| `/` landing hero | **yes** — the only mount |
| `/login`, `/login/mfa`, `/login/enroll`, reset, invite | no |
| Every `/app/*` screen | no |

The authenticated application never imports the scene. `HeroVisual` dynamic-imports
`RecoveryNetwork`, so the chunk is requested only when the landing page renders in
a WebGL-capable browser. The browser suite confirms the chunk is requested on `/`
and **not** on `/login`.

## 3. Files

| File | Responsibility |
| --- | --- |
| `client/src/features/public/recovery/HeroVisual.jsx` | host: WebGL capability probe, lazy import, Suspense + error boundary, device tier, reduced motion, viewport/tab pausing, context-loss capture, static fallback |
| `client/src/features/public/recovery/RecoveryNetwork.jsx` | the scene: seeded geometry, hand-written shaders and buffers, entrance, render-loop ownership, pointer parallax, hover focus, disposal |
| `client/src/styles/screens.css` | hero box, scene host, clipping mask, fallback gradient, phone band, short-viewport rules |

No 3D library is installed: the renderer is WebGL 1/2 through the browser's own
APIs. The decision and its measurements are in §12.

## 4. Scene composition

| Element | Geometry | Count | Draw calls |
| --- | --- | --- | --- |
| Care core | 20-facet icosahedron, r 0.42, flat normals, simple lambert | 1 | 1 |
| Inner bloom | additive point sprite | 1 | 1 |
| Core glow | additive point sprite, r 1.95 | 1 | 1 |
| Outer halo | additive point sprite, r 2.7 | 1 | 1 |
| Pathways | one `LINES` buffer (ring edges + cross links + spokes) | 1 | 1 |
| Nodes | `POINTS` with a per-node scale buffer | 15 / 24 / 36 | 1 |
| Signals | `POINTS` with a dynamic position buffer | 5 / 10 / 18 | 1 |

Seven draw calls, one buffer for every path, no textures, no shadows, no
post-processing, no per-frame allocation. The context is created with
`alpha: true`, `antialias` per tier, `powerPreference: 'low-power'` and
`premultipliedAlpha: false`; the clear colour is fully transparent so the page's
gradient shows through. Depth testing keeps the core in front of the pathways
behind it, while the additive layers do not write depth.

Camera: `fov 42` (focal 2.605), start `z 7.1`, settles at `z 6.25`. Rotation is
0.045 rad/s (≈2.6°/s) with a ±0.03 rad tilt oscillation. The core breathes at
≈0.135 Hz with ±3.5 % scale. Signals travel at 0.08–0.18 of an edge per second.
Nothing in the scene is faster than the eye can follow.

## 5. Ownership: one animation system

There is no second animation library in the scene. One requestAnimationFrame loop
owns every animated value, and the entrance is a cubic ease in the same loop:

| Property | Owner |
| --- | --- |
| Entrance progress, group scale, camera depth | the loop (ease-out over 1.2 s) |
| Orbit rotation, core/glow breathing, camera parallax | the loop |
| Hover scale for one node | the loop, writing one float into the scale buffer |
| Signal positions | the loop, writing the dynamic position buffer |
| Static node positions and pathway vertices | setup, once |

Because one system writes everything, a paused loop leaves a correct still frame
and a resumed loop does not jump. Entrance: progress 0→1 (1.2 s), camera settles
from 7.1 to 6.25, core and glow fade in. The hero copy runs its own 450 ms
stagger on the same start, so headline and network resolve together.

## 6. Interaction

| Interaction | Implementation | Guard |
| --- | --- | --- |
| Camera parallax | Window `pointermove` writes a normalised position; the loop eases the camera offset by ±0.28 / ±0.16 world units | Canvas is `pointer-events: none`, so it never competes with a link or button; off under reduced motion and on the mobile tier |
| Hover proximity pulse | Nearest node within 0.24 NDC of the pointer eases to 2.4× and back; only that instance's scale is rewritten | Uses the already-tracked window pointer; no canvas events |
| Camera entrance | Entrance progress | Final state under reduced motion |
| Signals | Interpolated along sampled edges | Frozen at 0.5 when reduced motion |
| Exit fade | `Landing` fades the page over 260 ms on "Staff sign in", then navigates; a 420 ms timer guarantees navigation even if the animation never ticks | Skipped for modified clicks and reduced motion |

## 7. Quality tiers

Chosen from viewport width, viewport height and rough device capability. A short
viewport (`max-height: 480px`) keeps the mobile tier, because an 844×390 phone is
still a phone.

| Tier | Viewport | Nodes | Signals | Max DPR | Antialias | Parallax |
| --- | --- | --- | --- | --- | --- | --- |
| desktop | ≥1100 px wide, ≥481 px tall | 36 | 18 | 1.75 | yes | yes |
| tablet | 720–1099 px | 24 | 10 | 1.5 | yes | yes |
| mobile | <720 px, or any viewport <481 px tall | 15 | 5 | 1.25 | no | no |

`hardwareConcurrency ≤ 4` or `deviceMemory ≤ 4` drops the result one tier; the
mobile tier then drops to 3 signals and DPR 1. Tier is exposed as `data-tier`
on the host for QA only.

## 8. Lifecycle and resource ownership

| Resource | Released by |
| --- | --- |
| `pointermove` listener | effect cleanup |
| `resize` + `ResizeObserver` | cleanup / `disconnect()` |
| `IntersectionObserver` | `observer.disconnect()` |
| `visibilitychange` listener | effect cleanup |
| Canvas, two programs, eight buffers | explicit `deleteBuffer` / `deleteProgram`, then the canvas element is removed |
| RAF loop | `frameloop` prop: `always` visible, `never` hidden/off-screen, `demand` under reduced motion |
| Context-loss listener | effect cleanup; `webglcontextlost` stops the loop and the host swaps in the gradient |

The page toggles the loop once per visibility change; it does not create a second
context. Repeated visits are covered by a QA check that round-trips
landing ⇄ login six times: exactly one canvas exists while the hero is mounted,
zero after leaving, and the post-GC JS heap is flat (+2 kB across two cycles).

## 9. Failure modes

| Failure | Behaviour |
| --- | --- |
| No WebGL constructor or no context | Static purple radial gradient, no canvas, no console error, no user-facing message |
| Shader/program failure | Gradient; the scene never throws into the page |
| Render error inside the scene | Error boundary swaps in the same gradient; the rest of the page is untouched |
| `webglcontextlost` / `webglcontextcreationerror` | `preventDefault()`, loop stopped, canvas unmounted, gradient shown |
| Module download fails | Suspense boundary keeps the gradient |
| Tab hidden | `frameloop="never"` |
| Hero scrolled out of view | `frameloop="never"` via `IntersectionObserver` |
| `prefers-reduced-motion: reduce` | Static composition, one frame (`demand`), no parallax, no rotation, no entrance |
| Forced-colours mode | The host is hidden by CSS; its value is entirely colour |

## 10. Accessibility

- The host and canvas are `aria-hidden="true"` and contain no text or focusable
  nodes. The canvas is `pointer-events: none`.
- Product meaning stays in semantic HTML: `<h1>`, tagline, `<nav aria-label="Primary">`.
- The hero copy carries a 22 px dark text shadow; contrast over the brightest
  scene area is preserved (the scene is masked and dimmed behind text).
- Keyboard: first Tab reaches "Staff sign in" with the 2 px focus ring; the canvas
  never receives focus (verified in the browser suite).
- No functionality depends on pointer movement or on animation.
- Reduced motion removes continuous movement entirely; forced-colours removes the
  decoration rather than rendering a black box.

## 11. One-viewport protection

The canvas is absolutely positioned inside `.landing__hero`, which clips it
(`overflow: hidden`). It cannot create document scroll, horizontal overflow, or a
hit target. Measured at all six required sizes: document width equals viewport
width, the sign-in link is inside the first viewport, and the hero is inside the
viewport.

The auth panel is a separate surface and never loads the scene. Short viewports
(`max-height: 620px`) top-align it and compress spacing; below 480 px a second
rule tightens only the vertical rhythm (no control or link is removed). At
844×390 and 320×400 the panel now fits with **zero page scroll**, so the submit
button and the reset link are both visible without scrolling.

| Size | Landing canvas | Hero in viewport | Sign-in link in viewport | Horizontal overflow | Login page overflow |
| --- | --- | --- | --- | --- | --- |
| 1440×900 | 1040×486 (desktop) | yes | yes | none | 0 px |
| 768×1024 | 850×540 (tablet) | yes | yes | none | 0 px |
| 390×844 | 564×413 backing, 451 css (mobile) | yes | yes | none | 0 px |
| 320×568 | 454×327 backing, 363 css (mobile) | yes | yes | none | 0 px |
| 844×390 | 939×320 (mobile) | yes | yes | none | **0 px** |
| 320×400 | 454×300 backing, 363 css (mobile) | yes | yes | none | **0 px** |

## 12. Dependency decision

**No 3D dependency is installed.** `three` and `@react-three/fiber` were removed
after the scene was rewritten against raw WebGL, because the library pair cost
238.83 kB gzip in the lazy chunk for one decorative hero.

| Check | Result |
| --- | --- |
| Existing dependencies | React 18.3.1, react-router 7.18, GSAP 3.15 (already present for the stage-1 motion layer) |
| Bundle | the lazy chunk is **13.11 kB minified / 4.99 kB gzip** (was 888.75 / 238.83) |
| Initial bundle | 464.11 kB / 132.60 kB gzip; the scene is not in it |
| Security | `npm audit` → **0 vulnerabilities** after the Vite 8 / Vitest 5 upgrade |
| Licence | no new dependency, so no new licence |
| Maintainability | ~430 lines of documented WebGL (shaders, icosahedron, matrix, buffers) versus a library pair for six draw calls; the scene's behaviour is fully covered by the browser suite |

The gates the rewrite had to keep: same props (`quality`, `reducedMotion`,
`frameloop`), the same seeded composition, additive blending, pointer parallax,
hover focus, context-loss fallback, lazy loading, and every check in
`qa/hero-browser-test.js`.

## 12a. Depth effects outside the canvas

All of it is CSS on existing markup — no component owns a WebGL context of its own:

| Effect | Where | Implementation |
| --- | --- | --- |
| Card elevation on hover | `.card`, `.info-card`, list rows | `translateY(-1px)` + shadow, 150 ms |
| Perspective card entrance | Overview information cards | `perspective(900px) rotateX(1.4deg)`, 380 ms, staggered 60 ms |
| Button depth feedback | `.btn`, `.btn--primary` | active: `translateY(0)`, reduced shadow, 90 ms |
| Active navigation indicator | `.shell__nav a.active` | 2 px brand bar via `::before` + surface tint, 150 ms |
| Care-plan timeline | `.table--timeline` on the plan version history | 1 px rail with a node per version, 260 ms row settle on tab open |
| Compact comparison bars | `.mini-bars` in the metrics panels | CSS bars, aria-hidden duplicate of the table |
| Loading skeleton | `.skeleton` | CSS shimmer, static under reduced motion |

## 13. Testing

`node qa/hero-browser-test.js` — 18 checks, **0 failures** on the final tree
(Chromium, headless, SwiftShader WebGL, Vite 8):

| Check | Result |
| --- | --- |
| Scene loads and paints | PASS — > 2 % of the page changes when the canvas is hidden |
| Quality tier and DPR cap at six sizes | PASS — desktop 1.75 / tablet 1.5 / mobile 1.25; landscape phone gets mobile |
| Canvas decorative (`aria-hidden`, no pointer events) | PASS |
| Camera clipped by the hero, no horizontal overflow | PASS |
| WebGL unavailable | PASS — gradient only, no page error |
| Context loss | PASS — canvas removed, gradient shown, page alive |
| Lazy chunk | PASS — requested on `/`, not on `/login` |
| Route remount ×6 | PASS — one canvas while mounted, none after leaving |
| Heap after GC | PASS — flat across cycles |
| Reduced motion | PASS — 0.00 % pixel change over 900 ms with a pointer move |
| Pointer parallax | PASS — < 1 % of the page changes (subtle, not a swing) |
| Foreground control | PASS — sign-in link navigates including the fade |
| Orientation change | PASS — canvas follows 451 → 939 css px |
| Keyboard | PASS — first Tab reaches the link with a 2 px ring |
| Frame pacing, 390×844, 4× CPU throttle | NOTE — ~60 fps, p95 16.8 ms under SwiftShader (not a device measurement) |

Unit/component (`client/src/test/hero-visual.test.jsx`, 7 tests): fallback when
WebGL is absent, decorative attributes, lazy load only with a context, reduced
motion → `demand`, tab hidden → `never`, visible again → `always`, tier ladder and
downgrade.

**Not run:** real mobile/tablet hardware, GPU/CPU profiling, Firefox and Safari,
and a real device battery measurement. The fps figure is a desktop proxy and is
reported as such.

## 14. Known limitations

1. No mobile hardware test. Tiers and caps are reasoned from geometry and draw
   calls, not measured on a low-end phone.
2. Hover focus is pointer-only, by design; touch devices see the composition
   without a hover state.
3. The scene is a single static composition with orbital motion; it is not a data
   visualization and must not be read as one.
4. Context restoration is not attempted: a lost context falls back to the gradient
   for the lifetime of the page. Reloading restores the scene.
5. While the scene now honours `prefers-reduced-motion` and forced-colours, there
   is no `prefers-reduced-transparency` treatment.
