# Preloaded native text experiment

Historical guide for version 0.3.3, available at Git commit `d01132d`. Version 0.3.4 removes the preload option and manual native scrolling in favor of swipe-controlled, one-line autoscroll. These controls are no longer present in the current app.

Version: **0.3.3-preload-test**. This experiment tests whether the physical Even host and G2 can accumulate an entire document in one native text container. The simulator accepts the calls but retains only the final chunk, so passing software tests does not establish hardware support.

## Test on the glasses

1. Reopen the reader's existing Prototype Mode URL. In Diagnostics, check the version above.
2. Tap **Sync library**, then choose **START - smooth-scroll test** (`Smooth-scroll-test.md`). Its source is [examples/smooth-scroll-test.md](examples/smooth-scroll-test.md); copy it into the library if it is absent.
3. Select **Native scroll**, tap **Back to start**, then enable **Preload text · experimental**.
4. Wait for **Transfer accepted**. Check whether the first visible line matches the phone preview: **START - smooth-scroll test**.
5. Swipe past Line 050 and continue toward Line 240 and END. Check for pauses or jumps around the former section boundaries. Try scrolling backward as well.
6. Try the phone percentage slider, wait for the new transfer, and compare the initial glasses passage to the phone preview. Reading from that point should continue without section replacements if accumulation works.
7. Tap **Send debug report** under Diagnostics after the test. Report what you saw; the debug report cannot read the physical display.

If the glasses initially show late-numbered lines or END, swipe upward. Earlier lines being unreachable indicates the final-chunk-only behavior seen in the simulator. Reaching START instead suggests that text accumulated, but loading moved the viewport. Both observations are useful and distinct.

To return to regular reading, choose **Pages**, or disable the preload option for ordinary native sections. The page overlap preference is retained. **Reload text** restarts the experiment at the phone's current starting line; the phone does not track native scroll position.

## What is being sent

- Initial reset: container identity and complete replacement text, with offset/length omitted.
- For text within the documented 2,000-character update size, try one complete update first.
- Otherwise, or if that attempt is rejected, replace the body with the first chunk and then insert successive chunks at the accumulated string length, with `contentLength: 0`. Each chunk is at most 900 UTF-8 bytes, and boundaries preserve complete wrapped rows and Unicode characters.
- All chunks load before reading. This avoids needing to preserve the viewport during an append while the user scrolls. It does not prove the host will leave the viewport at the start after loading.
- Offsets currently count JavaScript UTF-16 units. The supplied test text is ASCII to isolate accumulation and capacity from firmware Unicode-offset differences. Try real documents with non-ASCII text after the numbered test works; those offset semantics remain unverified on hardware.
- Total preloaded text is limited to 64 KiB for this experiment. An over-limit selection or rejected chunk switches to Pages without moving the selected position. A hung bridge call retains the SDK lane until it settles, so recovery cannot overlap it.
- Changing document, position, mode, or reloading cancels the old transfer between SDK calls. Opening the system menu interrupts loading; resuming restarts an interrupted transfer. Completed transfers are retained for status-only updates.

The progress report records accepted bytes, strategy, call count, loaded row range, and `verified: false`. The same report is included in the authenticated server reading state and remote-test inspection. A success response cannot establish retention, pixel delivery, or physical scrolling quality.

## Reproduce with the simulator

```bash
.tools/bin/xvfb-run -a npm run test:simulator:preload
```

The test uses the numbered document, exercises loading, native inputs, a phone jump, and return to ordinary native and page modes. It checks that scrolling the preloaded container sends no text replacements and that recovery produces no SDK/JavaScript errors. Review the recording and screenshots separately to assess the simulator's known retention failure.
