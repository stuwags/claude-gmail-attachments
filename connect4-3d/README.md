# Connect Four — Grandmaster

A photorealistic 3D Connect Four for macOS and iPadOS, with an opponent that
scales from "a seven-year-old can beat it" to "you will not beat it", and a
teaching layer that shows children the lines on the board instead of making them
guess.

The set is art-directed as a premium desk object: smoked acrylic panels in a
bead-blasted aluminium frame, lacquered ceramic discs, on a basalt slab lit by a
single large softbox. The complete specification — every hex value, light
intensity, material parameter and motion curve — is in
[`docs/ART_BIBLE.md`](docs/ART_BIBLE.md), along with the acceptance checklist
that rendered frames are graded against.

## Running it

Needs Node 20.19+ (or 22.12+). Check with `node -v`; on a Mac, `brew install node`.

```bash
# -b matters: the game lives on this branch, not on main, so a plain clone
# lands somewhere without a connect4-3d directory at all.
git clone -b claude/3d-connect4-ai-game-8mo1ai \
  https://github.com/stuwags/claude-gmail-attachments
cd claude-gmail-attachments/connect4-3d

# The skip flag avoids downloading ~150 MB of Chromium you don't need —
# Playwright is here only for the screenshot and smoke-test tooling.
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install

npm run dev          # then open http://localhost:5173
```

Other scripts:

```bash
npm run build        # typecheck, then bundle to dist/
npm run preview      # serve the production build
npm test             # rules engine, threat analysis, search, drop physics
npm run shots        # render reference frames (needs the browser download above)
npm run smoke        # play the game headlessly and assert it works
```

The game needs WebGL 2 — Safari 15+, or any current Chrome, Edge or Firefox.
It runs far better on real hardware than in a headless container: everything in
`shots/` was rendered on a software rasteriser with no GPU.

## Playing

| Input | Mouse / trackpad | Touch |
|---|---|---|
| Aim | Move the pointer over a column | Press and drag across the board |
| Drop | Click | Release, or simply tap a column |

Keyboard: `1`–`7` drop into a column, `←`/`→` move the selection, `Enter` or `↓`
drops, `U` undoes, `R` restarts, `Esc` opens the menu.

Undo takes back a full exchange — your move and the computer's reply — so you
get your decision back rather than handing the position straight back to it.

## Difficulty

**Easy** is a friendly beginner. It always takes a win it can see and blocks an
immediate loss most of the time, so a child can win but is still punished for
leaving a three open. This is the mode the coach is built for.

**Medium** is a solid club player: it never misses a win or an immediate block,
and avoids obvious traps, but it does not see deep forced sequences.

**Hard** searches with alpha-beta, iterative deepening and a transposition table
inside a fixed time budget. It will not fall for a two-move trap and it will
find a forced win when one exists.

The search runs in a Web Worker, so the board keeps animating at full frame rate
while the computer thinks. If workers are unavailable — some `WKWebView`
configurations refuse module workers — it falls back to searching inline rather
than refusing to start.

## The coach

The thing that makes this useful for a child learning the game.

In Easy mode the board marks every line that is two or three discs long, **for
both players**, so a beginner can see their own opportunities and, more
importantly, the threats being built against them. Three visual devices carry it:

- a **filament** threading the discs that already exist, so a line reads as a line;
- a **ghost disc** sitting in the cell where the fourth would land;
- a **ring** on the front panel marking that landing cell from head-on.

Urgency is encoded three separate ways — brightness, motion, and a doubled ring
stroke — so it survives colour-blindness and a greyscale screenshot rather than
relying on colour alone. A hard budget caps how much can light up at once,
because an overlay that marks everything teaches nothing. Hovering a column
reveals every line that playing there would touch, which is the single best
teaching moment the coach has.

The full art direction for it is in `ART_BIBLE.md` §7.

## Shipping to Mac and iPad

The build is a full PWA and installs from Safari with **Share → Add to Home
Screen** on iPad, or **Share → Add to Dock** on macOS. It runs full-screen and
offline; there are no downloaded assets, because every texture and every sound
is synthesised in code at startup.

For an App Store binary, the project is wired for Capacitor:

```bash
npx cap add ios      # once, on a Mac with Xcode installed
npm run cap:ios      # build, sync, and open Xcode
```

The same iOS target runs on iPad and, via "Designed for iPad" on Apple Silicon
or a Mac Catalyst destination, on macOS. `npx cap add ios` needs macOS, so it is
not run here.

## How it is put together

```
src/
  engine/     rules, threat analysis, and search — no rendering, fully tested
  render/     scene, materials, geometry, camera, post-processing, effects
  game/       state machine, input, audio, worker plumbing
  ui/         DOM chrome
  physics/    the drop simulation
tools/        screenshot harness and icon generator
docs/         the art bible
```

The seams between those are explicit interfaces — `render/api.ts`,
`render/post/types.ts`, `render/effects/types.ts`, `ui/types.ts` — so the
renderer can be rebuilt without game logic noticing, and the game logic can be
tested without a GPU.

Two implementation choices are worth knowing about:

**The drop is solved, not integrated.** A falling disc is a ballistic body with
a sequence of inelastic bounces, and every segment has a closed form. Sampling
that analytically means identical motion at 60Hz and at 120Hz on an iPad Pro,
with no integration drift, and it means the exact contact time is known before
the frame it happens on — so the impact sound is scheduled on it rather than
chasing it a frame late.

**Nothing is downloaded.** Textures come from procedural noise, the environment
map is a studio built in code and baked through `PMREMGenerator`, and every
sound is modal synthesis — a noise exciter driving decaying inharmonic partials,
which is why a disc landing on a tall stack sounds different from one hitting the
empty floor of the board.

## Visual review

```bash
npm run shots        # renders every scene at Mac and iPad resolutions
```

This drives the real game in headless Chromium through the `window.__c4` debug
hook and writes PNGs to `shots/`. It is how the look is reviewed — against real
frames at real device resolutions, rather than against an intention.
