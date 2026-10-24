# Reflow performance and Claude acceptance — 0.8.5

Measured on the local Linux computer in installed Google Chrome, October 4, 2026. These are desktop timings, not predictions of iPhone or glasses display latency.

## Cold PDF preparation

Every run uses a new browser context with no saved preparation or in-memory OCR result. Modules load before timing; document parsing, worker startup, OCR, provisional layouts and final layout construction are included. The baseline is commit `c392bb4` (0.8.4). Repeat runs use fresh contexts in the same Chrome process.

| PDF | Before | After | Result |
| --- | ---: | ---: | --- |
| Giving Reasons, 28 pages | 269.2 s | 105.2 s | 2.56× faster |
| Giving Reasons, first three pages ready | 20.5 s | 8.4 s | Prose available earlier |
| Memorizing Transformers, 19 pages, median of three runs | 3.57 s | 2.23 s | 38% less time |

Giving Reasons was measured once per version. OCR alone accounted for 239 seconds in the baseline. The accelerated Tesseract SIMD LSTM core retains the original English model, resolution and recognition options. Feature detection selects the scalar core on older engines. Both cores are bundled locally, with no download required. This follows [Tesseract's recommendation to select an appropriate core for each device](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md).

For embedded-text PDFs, the final pass now reuses a provisional page only when its source text and full analysis inputs match. Masks, body size, note style, end-matter state, Roman-heading state and OCR failures participate in that comparison. It keeps existing layout objects, not another set of full-page canvases. Memorizing Transformers needed 20 page preparations instead of 37. Giving Reasons still needed all 55 because its final analysis changed those inputs; recognition acceleration supplied its improvement.

The complete serialized preparations are byte-for-byte identical before and after for both real PDFs and nine fixtures: mixed columns, magazine, annotations, repeated text, figure, table, margins, colors and equation. That comparison includes extracted text, wrapping, notes, source coordinates, image bounds, color profiles, headings, page breaks and crop masks. Existing saved preparations remain valid; no cache-format increment is needed.

Local evidence is under ignored `test-results/pdf-profile-{before,after}` and `test-results/pdf-profile-repeat-{before,after}`. To benchmark another local PDF:

```bash
PROFILE_RESULTS=test-results/my-baseline npm run profile:pdf -- /absolute/path/paper.pdf
# After a change, optionally require identical preparation:
PROFILE_RESULTS=test-results/my-after PROFILE_COMPARE=test-results/my-baseline npm run profile:pdf -- /absolute/path/paper.pdf
```

`npm run test:pdf-ocr-core` exercises the accelerated and forced scalar paths offline in separate browser contexts and compares the entire preparation. The normal PDF progress, background, cache and loading-cancellation suites cover the app's interaction with these paths.

Release validation passed: 248 unit tests; SIMD/scalar offline equivalence; progressive reading and saved-position restoration (including the real Giving Reasons scan); background preparation with animation frames disabled; cache pixel/position equivalence and recovery; and 12 one-click PDF cancellation cycles under 4× Chrome CPU throttling with no active workers left behind. The loading test also checks Ask against its synthetic endpoint while later PDF pages are stalled. That simulated-provider check is separate from the real Claude acceptance below. No browser errors were reported.

## Live Claude through Chrome

An isolated ordinary Claude Code 2.1.289 session used native Remote Control and the local modified Even Terminal server. The test selected that existing session through Pageborne's session picker; no SDK-created replacement or unrelated conversation was used. Typed questions about an original synthetic notebook passage returned real Claude answers.

Verified: first answer, follow-up after leaving Ask, background `Reply ready`, exact return position, and reuse of the same session after reloading Pageborne. The test owner was closed afterward. Voice, the public tunnel, phone WebView and physical glasses were not part of this check.

The opt-in harness is `npm run test:ask-claude-live`. It requires `LIVE_TERMINAL_STATE` pointing to the private pairing file and `LIVE_CLAUDE_BINDING` pointing to a binding JSON for a dedicated test owner (`localId` and a `cwd` containing `pageborne-claude-test-`). `SHOW_BROWSER=1` records and displays a separate Chrome window. Never supply an unrelated conversation. Results, screenshots and video are in ignored `test-results/ask-claude-live`; credentials are not written into its report or the app package.
