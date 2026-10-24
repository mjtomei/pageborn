# Native text scrolling research

Update September 19, 2026: version 0.3.4 removes native section scrolling and the preload experiment. It offers Pages and Autoscroll, with swipes controlling speed. Autoscroll sends an eight-line native text window and advances it one row per timer step, waiting for outstanding host calls before continuing. The current installed SDK 0.0.14 and the rechecked [official method/type reference](https://github.com/even-realities/everything-evenhub/blob/main/plugins/everything-evenhub/skills/sdk-reference/SKILL.md) expose no viewport-position, native autoscroll, or animation command. Consequently this avoids the old asymmetric section handoffs but remains visibly discrete. No claim of smooth pixel animation or hardware timing is made. The research below describes the earlier modes and probes.

Reviewed September 18, 2026. Reader uses SDK 0.0.14 and official simulator 0.9.5. The preferred design is to preload the entire document in one container and navigate its viewport. Pending support for that, version 0.3.2 implements the requested fallback: full page turns with configurable overlap.

## What limits the loaded text

The [official SDK reference](https://github.com/even-realities/everything-evenhub/blob/main/plugins/everything-evenhub/skills/sdk-reference/SKILL.md) describes 1,000 characters for initial text and 2,000 characters per `textContainerUpgrade` call. Its partial-update fields are `contentOffset` (start position) and `contentLength` (number of characters replaced). It does not establish an independently tested maximum accumulated container size after repeated appends. A per-call limit must not be reported as proof of a total storage limit.

Reader's `src/native-text.js` currently limits a native section to 900 UTF-8 bytes and 40 wrapped rows, whichever comes first. The byte cap was chosen for simulator compatibility, not because physical glasses have a verified 900-byte buffer. A short document fitting both limits can already be loaded in full. The phone retains the complete document.

The existing simulator append probes use a 359-byte initial string and 360-byte additions. Both nonzero replacement length and zero-length insertion returned success but replaced the displayed content rather than accumulating it; the viewport reset. A 1,799-byte replacement returned false. See `test-results/native-api-probe/` and `test-results/native-insert-probe/`. Those observations cannot establish firmware append behavior or its total capacity.

A fresh full-text test used content-only updates, with no offset or length fields. Simulator 0.9.5 accepted 900 and 999 ASCII bytes, rejected 1,000, 1,001, 1,500, 1,999, 2,000, 5,000, and 20,000 bytes. Rebuilds accepted 999 but rejected 1,000, 1,999, and 5,000. Updates containing 499 copies of `é` (998 bytes) passed; 500 (1,000 bytes) failed. This confirms a byte limit in this simulator path, including ordinary whole-string updates. Artifacts: `test-results/full-text-capacity-probe-20260918/`.

The other requirement for preloading is phone-controlled viewport positioning. The installed SDK exposes no native scroll-position setter; `contentOffset` selects text to edit, not a viewport position. A larger accepted payload by itself would not implement phone-controlled jumps.

## Inspected implementations

| Project | Observed implementation | Relevance |
| --- | --- | --- |
| [G2-md-browser](https://github.com/r-castelo/G2-md-browser/blob/8bec950c4affc9bb1ac90d5bec688cee84d45eab/src/adapters/glassAdapter.ts) | Paginates the document; `updateReaderText` writes the complete selected page at offset zero. The reader body does not capture events. | Native text page turns, not a growing scroll buffer. “In-place” here means updating an existing container, not necessarily preserving its viewport. |
| [Glance pagination](https://github.com/tntpsu/Glance/blob/bac08516169092643cfdc177c89246b22d1bde8c/src/main.ts) and [display updates](https://github.com/tntpsu/Glance/blob/bac08516169092643cfdc177c89246b22d1bde8c/src/even.ts) | Page mode caps chunks at 400 characters; line mode at 100. `writeMain` sends the whole chunk at offset zero. | Smaller discrete text replacements, not evidence of seamless native scrolling across updates. |
| [even-bridge](https://github.com/invendor/even-bridge/blob/4634617239534cdfcaa741321c1969553e9922c0/src/public/js/ui/glasses.js) | Uses a blank event-capturing container with visible text in a separate non-capturing container. | Independently corroborates the approach used by Reader's page-mode bounce fix. |
| [G2CC protocol research](https://github.com/expectbugs/G2CC/blob/master/docs/G2_BLE_PROTOCOL.md#63-upgrade--partial-text-replace-group-3) | Documents a captured partial update with offset 4, replacement length 4, and text `####`. | Strong evidence that partial-string commands reach the hardware protocol. Does not demonstrate appending, maximum buffer growth, or viewport preservation. |

G2CC's [probe source](https://github.com/expectbugs/G2CC/blob/master/sdk-demo/src/main.ts) matters: its UPGRADE test starts with a short, non-event-capturing body, performs a full replacement, then the offset-4 edit. It does not scroll during this test. The wire trace therefore cannot settle our scrolling question.

The first-party [text-heavy template](https://github.com/even-realities/evenhub-templates/blob/main/text-heavy/src/main.ts) also uses pagination. An [AI Wire JP author report](https://blog.takumi-oda.com/blog/2026/08/12/even-g2-news-reader/) describes overlapping text windows and lack of a scroll-position API, but I did not establish an available source repository for that app.

Search also found an [append example in community documentation](https://github.com/kyle-deprow/ai_scaffolding/blob/main/skills/g2-display-ui/SKILL.md). It uses offset equal to the current string length and replacement length zero. Its referenced application/probe source files were absent from that repository's main tree when checked, so it is a hypothesis rather than a verified implementation. These are the semantics our zero-length simulator probe already attempted.

Whisprompt's public repository contains release documentation and screenshots, without implementation source in the inspected tree. It cannot supply a reviewable open-source solution to this question.

## What remains to establish

Partial replacement, append support, and scroll preservation are separate capabilities. The most useful next isolated experiment would:

1. Replace a few ASCII characters in a fixed-length string, matching G2CC's offset-4 test, and inspect the actual display.
2. Scroll a longer buffer to a marked middle line and edit text below it; verify whether the same line stays at the same screen position.
3. Append below the viewport with `contentOffset = currentLength` and `contentLength = 0`; verify old and new text are both reachable.
4. Grow the accumulated buffer beyond 1,000 and 2,000 characters using individually small updates. Check rendering and navigation, not just success responses.
5. If those pass, test Unicode offset units and trimming text from the beginning. Removing earlier text can move the viewport even when appending works.

Successful accumulation could let us preload an entire document, or at least much larger sections, without replacing text while the user scrolls. That is a conditional design opportunity, not an established firmware capability. The simulator currently fails the append behavior needed to validate it, so simulator-only work cannot settle the hardware question.

The separate [double-buffer experiment](test-results/double-buffer-probe-20260918/REVIEW.md) also found no working seamless swap: brightness did not hide the inactive text, and rebuilding to transfer input capture reset native scroll positions. This is likewise simulator evidence, not proof that every firmware route is impossible.

Version 0.3.3 implements an opt-in [preload experiment](PRELOAD-TESTING.md). It loads the selected remainder of the document before reading, using partial updates only during loading when a complete update is too large or rejected. This can avoid requiring viewport preservation during live appends, but still depends on accumulation, capacity, and the viewport's position when loading finishes. Its acknowledged calls do not establish those physical behaviors.
