# A2: Apex Rush on Bloom (Three.js game → native macOS / iOS)

> **About this file.** The agent that did this port never updated `NOTES.md`; the copy originally published
> here was A1's browser-game notes, unchanged. It was replaced on 2026-11-26 with this summary, written by hand
> from [`PORT_LOG.md`](PORT_LOG.md). **`PORT_LOG.md` is the agent's own record and the source for everything
> below.** The original file is still in this repository's git history (commit `5425ad5`). A1's notes, which
> describe the game itself, are in [`../a1-threejs-web/NOTES.md`](../a1-threejs-web/NOTES.md).

## What this arm is

A1's finished Three.js browser game (`src/`), compiled to a native app with **Perry** (built from `main`,
`1095f50fc5`). It runs on Bloom's Three.js bridge (`@bloomengine/three` + `@bloomengine/web`). The rule was to
change as little as possible: three.js, `GLTFLoader`, three-mesh-bvh, the physics, the AI and the game
structure are all unchanged. Everything native lives in `bloom/`.

```sh
sh bloom/build.sh            # bloom/dist/apexrush (runs from the repo)
sh bloom/build-macos.sh      # bloom/dist/macos/Apex Rush.app
sh bloom/build-ios.sh device # build, sign, install and launch on a connected iPhone (needs your own signing setup)
```

## Changes (PORT_LOG summary)

* 17 entries:
  * 3 at level 1 (already worked);
  * 10 at level 2 (small shim or adapter);
  * none at level 3 or 4;
  * 4 left unfixed: particles, flames and speed lines (12), sky and IBL (13), gamepad (16), table layout (17).
* Lines changed: **2 in the game** (`import.meta.env?.…`), **222** in native adapters (`shims.ts` 179,
  `config.ts` 34, `main.ts` 9), and **204** in build and packaging. **Total 428.** Bridge, engine and Perry
  sources: 0.

## Results on the native targets

| | macOS (`Apex Rush.app`) | iPhone 16 Pro |
|---|---|---|
| Full 3-lap race, correct results | ✓ (results table renders as blocks, entry 17) | ✓ (only 2 of 4 result rows fit, entry 17) |
| Win / lose | autopilot finished 2nd | autopilot finished 1st |
| Nitro | ✓, but flames and speed lines are missing | same |
| No tunnelling, resets, anti-shortcut | same game code; **not re-run natively** | — |
| Multi-touch | n/a | touch UI works; **not tried with real fingers** |
| Frame rate | 66–73 fps (Retina 2560×1440, Medium preset, full HUD) | **59.5–59.8 fps with the phone profile** (Low preset + flat HUD stylesheet + page updates every 2nd frame, i.e. 30 Hz); **38.4 fps without it** |

* **No part of the phone profile was enough alone.** On the iPhone the log measured:
  * Low preset alone: 43.9 fps;
  * Low plus 30 Hz page updates: 49.4 fps;
  * decoration stripped at Medium: 47.6 fps.

  Only the full combination clears 55 fps (entry 14).
* **Not measured on an iPhone 12**, the spec's target device. The log expects the A14 to fall below 55 fps with
  the same profile.
* **Gamepad** returns no controllers natively (entry 16).
* **The sky** is flat grey-blue; there is no equirect background or IBL (entry 13).

## Biggest problems found

1. **The page engine (DOM/CSS HUD) dominates the frame.**
   * The page cost 14–17 ms per frame on the iPhone, against 1–2 ms for the game itself.
   * Any DOM change re-runs the whole page, and decoration expands into about 10,200 draws per frame at 3×.
2. **`AudioParam` keeps every scheduled event.** Per-frame engine-sound automation slowed the game from 57 to
   35 fps after about 3 minutes.
3. **Perry 0.5.1664 failed to compile three.js 0.187 and three-mesh-bvh.** The fix was building Perry from
   `main`.
4. **Vite assumptions** (`import.meta.env`, `publicDir`) break on the first launch.
5. **`Sprite`, `InstancedMesh`, `Points` and the equirect background are not drawn,** and the 2D canvas is
   incomplete (`drawImage`).

## Sizes and effort

* **Sizes** (from `du`, not in PORT_LOG): macOS `.app` 94 MB, iOS `.app` 103 MB.
* **Effort:**
  * 165 model calls; 111,682 output tokens; 36,250,122 input tokens in total.
  * 2 h 57 min wall clock, of which about 2 h 38 min was working time.
  * Native build: about 2 min the first time and about 16 s incremental, not counting the one-off Perry build
    from `main` (about 26 min including the iOS runtime).
