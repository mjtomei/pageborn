# Shared preview/glasses controls — 0.8.3

The Claude Design preview tap/swipe feature now uses the same semantic bindings as glasses input. `src/controls.js` owns SDK event mapping, preview gesture actions, keyboard shortcuts, the app menu and control hints. `src/preview-input.js` only recognizes pointer sequences and adapts keyboard events. Both dispatch to `handleAction` in `main.js`; swipes therefore change rate in autoscroll/speed mode, navigate pickers, and page answers/footnotes consistently.

Tap selects/advances/pauses; double tap goes back; hold starts Ask and release sends. Swipes down/left mean next/faster; up/right mean previous/slower. The preview reserves both axes, so drag outside it to scroll the phone page. A tap waits 300 ms to distinguish a double tap or tap-then-hold, which opens the shared app menu. Menu is also a labeled button. A sustained single press begins after 550 ms; cancellation, focus loss, navigation or a second finger discards recording. Keyboard: Space/Enter tap; Esc back; arrows swipe; hold A to ask and release to send; M menu; Page Up/Down advance pages; Home/End jump. Inputs and browser shortcuts retain normal behavior.

The SDK parser recognizes long press/release in sys, text and list envelopes. OS-owned gestures (brightness, display off and switching apps) cannot be synthesized through this app; only Pageborne menu entries are mirrored. Unit sequence tests plus real browser mouse/touch events check routing, no first-tap page jump, app/position menus, held recording, cancellation and exact reading return. The official simulator retains its hardware-input checks.

---

# Phone UI integration — 0.8.2

Recovered `~/Downloads/pageborne-remote-themes-latest-20261004.zip` from Chrome's automation download directory. Its internal 0.7.23 filename is stale: this is the third design pass. SHA-256: `544659f745618930e1dbe6804bb3d849feb9c41efe15ba6bb121f8ff51c9cf0f`. The differences from the prior return were merged onto the current reader, preserving incremental PDF preparation, footnotes, single-spaced Markdown, themes and Ask.

Shared settings and Ask connections now live in the library. The update adds a compact passage heading, heading/bookmark slider ticks with scrub labels, next/previous search results, recent-first library order and progress bars, collapsible completed imports, steppers for small numeric ranges, long-press/quick bookmarks and a tappable/swipeable glasses mirror. The mirror routes Ask gestures to the answer, and long-press bookmarking leaves the reading position unchanged. Original hidden range values remain available for simulator controls.

The UI suite checks these interactions and the existing numeric controls, system theme, focus, drawer/dock layout and unobscured passage. Ask checks exercise the new settings location and per-paper connections. The revised design does not change PDF serialization or glasses display protocols. Earlier integration notes follow.

---

# Phone UI integration — 0.7.25

The latest design comes from `~/Downloads/pageborne-remote-themes-0.7.23.zip`, based on source commit `f285afec3ef7241c6d6d46f69dfb70dbb1744917`. It was merged onto 0.7.24 so recognized footnote brackets and the current reading engine remain intact.

## Current design

- **Settings → Appearance → System** is the default. CSS `prefers-color-scheme` follows the phone/browser's reported preference, including changes while open. Explicit Light/Dark overrides are saved with shared phone preferences and restored after a fresh WebView starts. Light is the fallback when the host reports no preference. The glasses mirror remains black/green; PDF pages remain on white paper.
- The floating dock starts folded on phones: mode/pace summary, position, and transport. Tap the summary to show modes, rate and word count. At desktop widths all controls are shown. The dock occupies layout space so passage text and Diagnostics remain above it.
- The page count is one button opening the numeric value dialog, with integer/range validation, Cancel/Escape and focus return. Back to start remains beside it.
- The **?** beside Reconnect toggles gesture hints inside the mirror. Hints start visible. Hint visibility and dock expansion are device-local browser presentation choices; reading data and theme choice use durable phone storage.
- PDF controls put Footnotes first and distinguish current-file formatting from defaults for new PDFs. After images remains under shared Settings; Bookmark this position remains in Marks.

The earlier drawer/tools/passage design and integration notes follow. Browser tests additionally cover system-following themes, overrides, cold phone-preference restoration, dock folding, page entry and hints. `scripts/theme-screenshots.mjs` captures both palettes using fictional samples. Neither a browser media emulation nor the simulator establishes whether a particular Even app build forwards its host system preference correctly.

---

# Earlier integration — 0.7.0

The interface comes from the user's Claude Design return, `even-reader-remote-ui.zip`, based on the 0.6.2 source snapshot at `e594c36`. Claude called the chosen direction “Remote”: a dark green console with the glasses preview, a library drawer, tools that open on demand, a persistent Read from here pane and a bottom transport dock. “Remote” is a visual direction; the app still uses local uploads and storage.

## Included design

- Document title opens the library below 1000px; desktop shows it as a column. The drawer retains import progress, filtering and confirmed deletion. The dock stays usable while it is open.
- Contents, Search, Marks and PDF open one panel. Hide closes it; the PDF tab is absent for Markdown/text.
- The follow control and passage border distinguish following the glasses from browsing independently. The Phone text selector remains beside the Markdown pane.
- PDF options retain their per-document behavior. The reflow size is labeled PDF text size to distinguish it from the Markdown phone-only setting.
- The dock exposes position, mode or speed and previous/play/next. Playing Autoscroll uses amber. Slower/faster buttons appear when there is room.
- System fonts, local assets, native selects, visible focus states and reduced-motion support keep the UI self-contained.

The returned reading, persistence, PDF/OCR and glasses modules matched the baseline. Integration changes are in index.html, style.css and main.js, plus the version and test/documentation updates. Storage keys, document data, source anchors and SDK display protocols are retained.

## Integration corrections

The desktop dock now uses two rows so all controls fit at 1280px. Speed buttons stay disabled at 6 and 200 after other controls refresh. Follow status refreshes after replacing the document layout. On phones, covered reader controls are inert while the library is open, but the dock remains usable. Notices move into the open drawer so errors remain visible. Escape returns focus, and library keyboard navigation does not trigger reading shortcuts. Empty-bookmark copy refers to the current bookmark icon.

## Verification

```sh
npm test
npm run build
npm run test:browser
npm run test:pdf
npm run test:ui
npm run test:chat-ui
.tools/bin/xvfb-run -a node scripts/simulator-test.mjs --record
.tools/bin/xvfb-run -a node scripts/simulator-test.mjs --pdf --record
```

The UI suite exercises drawer/dock interaction, playback while browsing the library, focus and Escape, covered controls, speed bounds, following/browsing state, error visibility and PDF-to-Markdown switching. It checks both reading modes at 360, 390, 430, 768, 1000 and 1280px. Browser library/storage and PDF checks use visible drawer/tool controls through scripts/ui-helpers.mjs.

`scripts/design-screenshots.mjs` captures phone/desktop states using the fictional samples from the Claude Design handoff. Set `SAMPLES` to that export's sample-documents directory and optionally pass `--widths=360,390,430,1280`. OCR/preparation screenshots capture timing-dependent states; successful rendering is checked separately by the PDF browser suite.

Local evidence is under `test-results/remote-ui-20260926/`, `test-results/remote-ui-design-20260926/`, `test-results/remote-ui-pdf-20260926/`, `test-results/remote-ui-native-simulator-20260926/` and `test-results/remote-ui-simulator-20260926/`. Browser and simulator checks do not establish physical glasses refresh latency or every iPhone WebView behavior.

`npm run pack` creates the installed-app package locally. It does not publish to Even Hub or update an existing phone installation.
