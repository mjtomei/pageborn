# Simulator debug loop

The current workflow uses the official Even simulator, the real SDK, and a temporary phone profile with local file imports. It needs no phone, glasses, camera, or physical gestures. The test harness drives the phone controls and simulator inputs.

## Run

From `reader/` on a desktop:

```bash
npm run test:simulator:record
```

This builds the current source, starts an isolated static test host and simulator, records the simulated glasses display, and runs:

1. Forty-five consecutive one-line autoscroll advances across former section boundaries, speed swipes, tap pause/resume, and a percentage jump.
2. Sixty rapid contents selections, checking the final chapter.
3. The glasses menu: Change mode, Start of doc, and Choose document, with remembered positions.
4. Local file uploads through the file input, a 1.5 MB background import while autoscrolling, table records in native text with page swipes and autoscroll, and deletion of the active and final documents.
5. Three minutes of repeated navigation and playback, checking for JavaScript and SDK errors.

Linux requires the simulator's GTK/WebKit dependencies, `dbus-run-session`, and a working graphical display. A headless machine can use an installed Xvfb:

```bash
xvfb-run -a npm run test:simulator:record
```

The process must be allowed to listen on localhost. Recording requires FFmpeg with libx264; the script uses `FFMPEG`, then the existing `.tools/bin/ffmpeg`, then `ffmpeg` on PATH. No Android tooling is required. For a quick pass without the stress loop:

```bash
SIMULATOR_SOAK_SECONDS=0 npm run test:simulator:record
```

`SIMULATOR_FPS` sets the screenshot sampling target (default 12, range 1–30). Requests never overlap: a slow screenshot lowers the sampling rate. `SIMULATOR_PORT` defaults to 9900. `SIMULATOR_RESULTS` selects an output directory; use a fresh directory for each recording. Recording stops after 15 minutes or 18,000 frames. To test longer, use the existing `npm run test:simulator` without recording after building.

## Review and reproduce

To check page turns and configurable overlap for unwanted movement during swipes, run:

```bash
npm run test:simulator:scroll
```

On Linux without a display, run this under `xvfb-run -a` once Xvfb is installed. The command requires localhost listeners just like the regular simulator run. It records eight scenarios: page turns in the middle and at both document ends, returning from Autoscroll to Pages, and forward/backward turns with 0, 1, 3, and 7 overlapping rows after a phone jump. The overlap scenarios assert the expected passage. Recording targets 30 samples per second; actual sampling can be slower.

This workspace also has a local Xvfb installation with a wrapper that sets its library paths:

```bash
.tools/bin/xvfb-run -a npm run test:simulator:scroll
```

The reviewed September 17 baseline is in [test-results/scroll-baseline-20260917/REVIEW.md](test-results/scroll-baseline-20260917/REVIEW.md). It reproduced page bounce and native section transitions both during scrolling and after a percentage jump, using the unchanged renderer. The review includes short clips and an additional backward-scrolling issue. Local tools and test artifacts are not part of the application build.

`scroll-reproduction.json` saves each synthetic swipe alongside the phone's position, page, and SDK activity. `recording.json` marks scenario boundaries and input timestamps. Watch for text displacement during page input. The simulator API sends discrete up/down actions; it does not reproduce a finger's physical trajectory.

The report deliberately leaves `bugsReproduced` as `null` and `review` as `pending`: a completed script proves only that the actions ran. Reproduction needs inspection of the recorded simulator output, and this may differ from the hardware report. A startup permission failure is neither a reproduction nor a pass.

Check page-mode motion against the settled frames in an existing recording:

```bash
node scripts/review-page-motion.mjs test-results/scroll-fix-final-20260917
```

This uses FFmpeg to compare lossless screenshot pixels. A page body must match a settled page, or consist of unchanged scanlines from the immediately previous and next page when capture catches a repaint. Displaced text fails the check. The same check fails on the original baseline. It does not validate native transitions or physical latency; inspect those clips separately. Version 0.3.1 fixes page bounce and native section skipping, but a native boundary pause/bounce remains in simulator 0.9.5.

The [reviewed 0.3.1 result](test-results/scroll-fix-final-20260917/REVIEW.md) includes before/after findings, short clips, test coverage, and the remaining limitation.

The [reviewed 0.3.2 result](test-results/page-overlap-20260918/REVIEW.md) covers configurable overlap, full page turns after phone jumps, and preservation of native in-section scrolling. All 674 sampled page-turn frames passed the displacement check. The separate menu/contents regression also passed; this update did not repeat the earlier three-minute soak.

Version 0.3.3's optional preload experiment and manual native scrolling were removed in 0.3.4. Their historical findings remain in [SCROLLING-RESEARCH.md](SCROLLING-RESEARCH.md); the current harness tests Pages and Autoscroll.

The [reviewed 0.3.4 result](test-results/autoscroll-final-20260919/REVIEW.md) covers 45 consecutive one-row advances, speed gestures, percentage jumps, 60 contents jumps, the real context menu, remote controls, and a 60-second/13-cycle stress run. The separate page recording passed all 778 sampled gesture frames with no text displacement. The browser suite also tested a slow host without skipping automatic rows.

The [reviewed 0.3.5 result](test-results/phone-library-final-20260919/REVIEW.md) verifies the reduced Change mode / Start of doc menu, the existing reading regression, full-document phone browsing, and phone imports through the browser file chooser. The simulator displays custom entries only in this view; it cannot establish system-slot placement on the glasses.

The [reviewed 0.4.0 result](test-results/local-library-20260920/REVIEW.md) covers local imports, deletion of the active and final documents, the existing reading regression, and a 30-second/7-cycle stress run. The browser suite also checks offline mutations, storage failures, and migration of saved documents and bookmarks. The production remote-testing API has been removed.

The [0.4.1 table run](test-results/tables-20260920/REVIEW.md) adds native table records, forward/backward paging and four sequential autoscroll rows. The browser suite checks cell search, bookmarks after reopening, and phone wrapping at all three text sizes.

The [0.4.2 background-import run](test-results/background-imports-20260920/REVIEW.md) verifies that a large worker import keeps Add files enabled, retains the open document and leaves autoscroll running. Imports now need an explicit document selection. The browser suite additionally holds slow reads while adding more files, deleting a completed file and continuing playback, then verifies independent completion, byte progress, duplicate names and persistence.

Version 0.4.3 uses the SDK's phone storage. The [phone persistence run](test-results/phone-persistence-passed-20260920/REVIEW.md) exercises native saves during reading, then closes the native display, clears browser storage and restores the library, reading position and bookmark on reopening. The browser suite also restores a library in a fresh browser context with no browser storage, retaining only the simulated companion app storage; ordinary reloads alone did not cover this boundary.

Run `node scripts/simulator-test.mjs --table-stress --record` for the separate large-table scenarios: 2,000 records, 40 columns, very large prose/Unicode cells and an unbroken 64,000-character value. See [stress evidence](test-results/table-stress-verified-20260921/REVIEW.md).

Run `node scripts/simulator-test.mjs --pdf --record` for PDF image scenarios: mixed single/two-column sections, a long paragraph, a tall vector figure, image autoscroll and returning to native Markdown. The PDF scenario also records text returning from a figure with three bottom-aligned lines, growing through four to nine lines without discarding the first, then resuming ordinary autoscroll. `npm run test:pdf-entry` checks configurable initial counts, saved settings, narrow layouts and each reveal with delayed SDK acknowledgement. Screenshots wait for acknowledgment of all four image tiles; intermediate frames can show a partial tile update. The [PDF run](test-results/pdf-release-20260921/REVIEW.md) records the results. `npm run test:pdf` separately checks offline PDF imports and the scrollable phone/browser preview. See [PDF reading](PDF-READING.md) for the local browser workflow.

Run `node scripts/simulator-test.mjs --speed --record` for Speed read: centered native word groups, configurable word count and words per minute, swipe rate changes, tap pause/resume, word-by-word phone navigation, the glasses position picker, the three-mode menu cycle and return to the library. Build first; use Xvfb on a headless Linux machine. `npm run test:speed` separately tests exact saved-word and bookmark restoration, short documents, logarithmic rates, numeric input limits, narrow screens, PDF figures and a delayed SDK bridge without skipped groups.

Each run prints its new directory under `test-results/official-simulator/`:

- `recording/simulator.mp4`: the display enlarged 2×, with screenshot alpha composited onto black so the green text stays readable.
- `recording/recording.json`: capture timestamps, command and checkpoint offsets, capture errors, and encoding status. Event `atMs / 1000` is the corresponding video time.
- `recording/frames/`: original PNG samples for frame inspection. Their transparency must be composited onto black when viewing. `frames.ffconcat` preserves sampling intervals for re-encoding.
- `01-*.png` through `08-*.png`: checkpoints from the test scenarios, including deletion and the empty library.
- `result.json`, `simulator.log`, `console.json`, `state.json`: assertions, host output, console messages, and final reported reading state. Some files may be absent after an early crash; `result.json` retains the last observed app state and failure.

When a test fails, the harness finalizes the available recording before terminating the simulator. An unavailable FFmpeg or failed encoding makes the recording run fail while preserving raw frames and timestamps. A simulator that stops answering screenshots leaves errors and a held last frame in the video. Review those errors before interpreting an apparently frozen screen.

The repeatable debug cycle is: run the failing scenario, inspect the video at the command offsets and the last SDK/JavaScript events, fix the issue, then repeat the same scenario and stress run. The simulator profile is temporary; the user's documents are unchanged. Version 0.4.0 has no production remote-testing API; only the temporary test page receives the injected automation driver.

## What the evidence means

This is a recording of sampled simulator output. The simulator reimplements the renderer; it does not run the glasses firmware or model Bluetooth transfer, physical display refresh, or the native Even app process on iOS/Android. It can expose navigation, menu, rendering, and SDK sequencing errors that reproduce there. Passing these tests does not resolve a crash that only occurs on a phone.

The video retains elapsed gaps between captures and holds the latest sampled image until the next sample. Its 30 fps encoding repeats those samples; it adds no motion interpolation. The first available sample is held from time zero. Capture request and completion times are both recorded because the exact render instant is unknown. Recording can itself affect simulator performance. Use it to inspect visible states and transitions, not to measure glasses latency.
