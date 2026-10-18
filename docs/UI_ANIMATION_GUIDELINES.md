# Velora UI — animation guidelines

Motion exists to explain a change of state, never to decorate clinical
information or to delay it. The rules below are the ones the code enforces; each
maps to a hook in `client/src/lib/motion.js` or a property of the Recovery Network
scene.

## 1. Vocabulary

| Token | Value | Used for |
| --- | --- | --- |
| `MOTION.instant` | 90 ms | press feedback, toggle |
| `MOTION.fast` | 150 ms | hover elevation, focus ring |
| `MOTION.base` | 240 ms | page transition, notice pulse |
| `MOTION.slow` | 380 ms | card/row reveal |
| `MOTION.reveal` | 450 ms | **hard ceiling** for any entrance |
| `MOTION.easeOut` | `power2.out` | entrances, reveals |
| `MOTION.easeInOut` | `power2.inOut` | state swaps |
| `MOTION.stagger` | 40 ms | child reveals, capped at 12 children |

Only `opacity` and `transform` are animated. Nothing animates `width`, `height`,
`top`, `left`, `margin` or `filter`, so no tween can trigger layout or paint work
that would cost frames on a phone.

## 2. Rules

1. **Nothing is withheld.** Content starts at **0.6 opacity, never 0**. A failsafe
   timer (600 ms page transition, 900 ms reveal) forces inline styles back to the
   visible state if GSAP never ticks — a backgrounded tab, a paused frame budget,
   an exception in a sibling effect.
2. **No animation gates input.** No tween sets `pointer-events`, no handler awaits
   a timeline, and every control is focusable while an entrance runs.
3. **One owner per property.** GSAP owns app entrance opacity/scale; the scene's
   own render loop owns its entrance, orbit rotation, breathing and camera
   position. No property is written by both (see §5).
4. **Bounded stagger.** `useReveal` animates at most 12 children; the rest appear
   with the last batch, so a long list never takes seconds to become readable.
5. **Cleanup is mandatory.** Every timeline is created inside `gsap.context()` and
   reverted in the effect's cleanup; listeners, observers and timers are removed in
   the same cleanup; the scene deletes its programs and buffers explicitly on
   unmount.
6. **Reduced motion is a real branch, not a shorter tween.**
   `prefers-reduced-motion: reduce` skips the tween entirely, renders the final
   state, and (for the 3D hero) freezes the composition and stops the render loop.

## 3. Where motion is allowed

| Surface | Motion | Why it is safe |
| --- | --- | --- |
| Authenticated page change | 240 ms fade + 8 px rise, keyed on pathname | Explains navigation without hiding content; rerenders do not replay |
| Card/row entrance | 380 ms stagger, ≤12 children | Orients the eye on lists and grids |
| Notice saved / copied | `pulse()` — 240 ms opacity/scale | Confirms a local action; the text is already in the DOM and announced by `role="status"` |
| Landing hero | GSAP entrance for the 3D scene + hero copy | Marketing page, no clinical content |
| Overview cards | CSS perspective settle, 380 ms, `rotateX(1.4°)` | Local to two information cards; no clinical values |
| Care-plan history | CSS timeline rail + 260 ms row settle | Reveals ordering; the version text is present from the first frame |
| Button, card, nav | CSS only: `transform`, `box-shadow`, `background` transitions ≤150 ms | Immediate, interruptible, no JS |
| Modal/drawer | Not built yet; when added, opacity + transform only, no focus delay | Stage 2 |

Motion is **not** allowed on: clinical values, medication names, dosages, plan
approval state, audit rows, error text, or anything that changes while a user is
reading it. A state change on those surfaces renders instantly and is announced.

## 4. CSS motion

Defined in `styles/base.css`, `components.css`, `screens.css`:

- Hover elevation: `translateY(-1px)` + shadow, 150 ms.
- Active/press: `translateY(0)` + reduced shadow, 90 ms.
- Focus: 2 px `#C4B5FD` ring, offset 2 px, no transition (must appear instantly).
- Active navigation indicator: 2 px brand bar + surface tint, 150 ms.
- Care-plan version history (`.table--timeline`): a 1 px rail with a brand node
  per version, plus a 260 ms opacity/translate settle that plays once when the
  history tab opens (staggered to 160 ms across rows). Removed under reduced
  motion, where the rows simply render.
- Perspective card entrance: `perspective(900px) rotateX(1.2deg)` settling to 0
  over 380 ms, used by the landing sections only.
- `@media (prefers-reduced-motion: reduce)` collapses all of the above to 1 ms and
  removes transforms.

No component creates its own WebGL canvas. Depth is CSS: one elevation scale,
one perspective use, one brand glow.

## 5. Recovery Network (WebGL)

The scene does not use GSAP. One requestAnimationFrame loop owns every animated
value:

| Property | Owner | Notes |
| --- | --- | --- |
| Entrance progress `0→1` | the loop | A cubic ease over 1.2 s; also derives camera depth |
| Group scale, core opacity | the loop | Written into uniforms |
| Orbit rotation, core breathing, camera position | the loop | No second writer exists |
| Node and signal position buffers | the loop | One hovered scale or the signal buffer per frame |

Sequence on mount (desktop, motion allowed):

| t | Event |
| --- | --- |
| 0 ms | canvas fades in at 0.92 container opacity; hero copy begins its own 450 ms rise |
| 0–1200 ms | entrance progress 0→1; camera eases from z 7.1 to 6.25 |
| 100–1000 ms | core and glow opacity 0→1 / 0→0.35 |
| 200–1100 ms | nodes appear |
| 300–1300 ms | connection paths fade in |
| 800–1400 ms | travelling signals appear |

After the entrance the scene runs continuously on desktop/tablet until the hero
leaves the viewport (`IntersectionObserver`) or the tab is hidden
(`visibilitychange`), at which point the frameloop is set to `never`. On return it
resumes without replaying the entrance.

Reduced motion: no entrance, no orbit, no breathing, no parallax, no travelling
signals; the frameloop is `demand` and the composition is drawn once.

## 6. Forbidden

- Flashing, strobing, or any opacity oscillation above 3 Hz.
- Full-scene rotation faster than ~2.7°/s (current: 0.045 rad/s ≈ 2.6°/s).
- Camera zoom the user did not ask for, or focus stealing by a canvas.
- Animating text in a way that changes its final position after a user could have
  read it.
- A second animation library, ScrollTrigger, or per-card WebGL.
- Loading animation code before first paint on the landing page: the WebGL scene
  lives in a lazy chunk, and GSAP is imported by the motion layer for the whole
  app only because the shell's page transition uses it.

## 7. Verifying motion rules

| Check | Method |
| --- | --- |
| Reduced motion renders final state | Playwright context `reducedMotion: 'reduce'`; assert opacity 1 and no inline transform |
| No layout animation | Review of `motion.js` (opacity/transform only) and CSS transitions |
| Cleanup | `hero-visual` unit tests assert the fallback path; manual route round-trips assert one canvas and no growing listener count |
| Timing ceilings | `MOTION` object is the single source; grep for `duration:` outside it and in `RecoveryNetwork` |
| Context loss | Canvas is removed and the static gradient renders; no error text |
