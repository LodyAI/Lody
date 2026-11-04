# Public-site shaders saturating integrated GPUs

Status: implemented
Translation: current

[中文](2026-10-15-site-shader-gpu-cost.zh.md)

## Abstract

The pricing, download and changelog ambient field and the landing point cloud
kept integrated GPUs at full load, and heavy GPU users still paid a noticeable
cost. The field ran four full domain-warped evaluations per pixel at 15Hz.
Its GPU-time backpressure relied on a WebGL1 timer extension that browsers
rarely expose, so it never engaged. The field now stores its two warped values
once and reads the ridge taps from neighbouring texels. It paces samples with
WebGL2 timers or fences, and caps presentation at 60fps. The landing stops
forcing the discrete GPU, drops MSAA on 2× buffers, and both scenes show a still
frame on software rasterisers. The image is unchanged to within 2/255. The
remaining limit is that no real integrated GPU was measured here; the evidence
comes from SwiftShader.

## Problem

- `marketing-atmosphere.tsx` evaluated `warped()` four times per pixel: `n`,
  `n2`, and the two forward-difference taps feeding `ridge`. That is about
  445 `sin()` per pixel. At dpr 1.5 on a 1080p window (4.7M pixels) this is on
  the order of 20 GFLOP per sample. At 15 samples per second, that fills a
  typical integrated GPU.
- The sampler scaled its interval from `EXT_disjoint_timer_query` on a WebGL1
  context. Browsers mostly do not expose that extension, so the loop fell back
  to a fixed 15Hz and never backed off.
- Presentation followed the display rate (120/144Hz on many laptops). Each
  frame also made the compositor re-blur every frosted panel above the canvas.
- The landing requested `powerPreference: 'high-performance'`, which wakes the
  discrete GPU on dual-GPU laptops. It also ran 4× MSAA on a 2× drawing buffer.
  Neither scene treated software rasterisers differently.

## Decision

- **Split field.** Pass one writes `n` and `n2` as 16-bit fixed point into an
  RGBA8 target. The target is one ridge step larger on the right and top edges.
  Pass two reads `n`, `n2` and the two taps as exact neighbour texels, then
  shades. The taps are still differences of the full `warped()`, as the
  filigree rule requires, so each sample runs `warped()` about twice per pixel.
  The step is rounded to whole buffer pixels (about 27px at 1620px; under 2%
  change). The single-pass program stays for allocation failure.
- **Backpressure that works.** Prefer a WebGL2 context. Use
  `EXT_disjoint_timer_query_webgl2` when present. Otherwise use a fence, minus
  the latency of a reference fence placed after a cheap present frame. Fence
  status reaches script frames after the GPU finishes, by a browser-dependent
  delay, so subtracting a fixed frame would throttle fast GPUs.
- **Presentation.** Cap blends at 60fps (30fps once a sample costs 25ms or
  more) and skip a present identical to the frame already shown. The inherited
  12ms floor had never fired, because no timer was readable. Once it could
  fire, it dropped an M2 Max at dpr 2 to about 38fps, so the floor now targets
  only GPUs the field saturates.
- **Software rasterisers.** One still frame for both scenes, the reduced-motion
  path, instead of an animation that costs seconds of every core per sample.
- **Landing.** Use the browser's default GPU, and request MSAA only below a 2×
  buffer.

## Alternatives not taken

- A cheaper hash (arithmetic or a precomputed noise texture). In SwiftShader a
  packed-corner texture was about 25% faster, and on real GPUs it is likely
  faster still. But it changes the specific noise pattern the field was tuned
  on. That is a visual decision for the owner, not a performance shortcut.
- Lower field resolution, a lower sample rate for everyone, or an analytic
  gradient. The first two are excluded by the marketing-shell rule. The
  analytic gradient weights the high octaves differently from the 0.016 step
  and changes the filigree.
- Pausing the landing below the hero. The fixed scene stays visible, dimmed,
  behind every later section.

## Verification

- SwiftShader, 960×540, two times, both themes: the refactored single pass is
  bit-identical to the old shader. The split pass differs by at most 2/255 per
  channel (mean ≤ 0.061/255) and costs about 0.55× per sample (≈ 400ms vs
  ≈ 690–780ms).
- `/price` in headless Chromium with the renderer string spoofed to a hardware
  GPU: WebGL2, split and temporal paths active, and the fence path backs
  sampling off on the slow device. Unspoofed (software), it renders two draws
  and goes idle: about 0.01 CPU cores, against 1.62 before.
- Landing at 2× with MSAA on and off: 2× zoomed crops of terrain, coral and
  jellyfish are indistinguishable. Per-frame CPU cost in SwiftShader fell about
  35–40%.
- Real GPU (M2 Max, 5K Retina, Chrome on Metal, dpr 2, 30s per page,
  whole-machine GPU reading with a 12–17% idle baseline): `/price` 36–40% →
  ~22%, `/changelog` ~31% → ~16%, `/download` ~42% → ~25%, landing 17–18% →
  ~15%. WebGL2, the split path and the GPU timer were active, and no visual
  change was seen. That run used the 12ms floor (blends at ~38fps); the 25ms
  floor was not re-measured.
- Not measured: power (needs sudo), a 120Hz display, low-end integrated GPUs,
  Safari, Firefox.
