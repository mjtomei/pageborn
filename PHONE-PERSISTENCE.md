# Persistent phone library

The persistence bug in versions 0.4.0–0.4.2 was reliance on IndexedDB and browser localStorage. Browser reload tests passed, but they did not cover the Even app replacing or clearing its WebView. [Even's device-features reference](https://github.com/even-realities/everything-evenhub/blob/main/plugins/everything-evenhub/skills/device-features/SKILL.md#local-storage) explicitly warns that browser storage is not reliable across app restarts, and directs apps to the native bridge storage APIs, including chunking large content. This reference was checked September 20, 2026; both APIs are present in the installed SDK 0.0.14.

Version 0.4.3 uses that SDK storage for the document library and preferences when a native host is available. IndexedDB remains a migration source and expendable cache. Without a native host, the ordinary browser preview retains its existing IndexedDB behavior.

## Writes and recovery

Document bodies are immutable and split into at most 32,000 UTF-16 units per key, without splitting surrogate pairs. A body descriptor records length, chunk count and checksum. The document index and preferences are chunked too. Each has two reusable slots and a small committed pointer; the inactive slot is written completely before that pointer changes. Keys are scoped with `even-reader:phone:v1`, independent of the app version and WebView URL.

Imports and deletions are serialized. A journal records the body being added or removed before its chunks change. On restart, recovery checks whether the committed index references that body before clearing unused chunks. SDK storage has no delete method, so unused values are emptied. An uncertain index-write failure blocks further file mutations until reopening rather than risking a second write against stale state. Missing or corrupt referenced chunks produce a visible error and do not reset the library.

The import queue reports Added only after the native library commit. A failed browser-cache write does not invalidate a successfully saved native file. Phone storage and display calls share the existing SDK lane; an import yields between chunks so display updates can interleave. Automatic reading waits for outstanding display frames, rather than treating a phone-storage call as a pending glasses frame.

Migration preserves old position keys and resumes if interrupted. A completed migration marker prevents stale browser copies from resurrecting deleted documents. Preferences use a separate coalescing writer; reading progress is saved during use and flushed on visibility changes/page exit. An immediate OS process kill can still interrupt the latest unsaved reading-position update, but cannot replace a committed library with an incomplete import.

## Verification

Unit tests exercise fresh-instance restoration, Unicode across chunk boundaries, migration interrupted between files, concurrent imports, per-stage write failures, cleanup of incomplete imports, persistent deletion and corruption handling. Preferences tests cover large values, failed writes, coalescing and idle flushes.

The browser test supplies SDK storage outside the browser context. After saving documents and bookmarks, it opens a fresh context with no IndexedDB, localStorage or cookies and verifies restoration through the real SDK. It also checks failed native saves, retained documents, background imports and serialized SDK calls. This specifically exercises the lifetime boundary missed by the previous reload-only test.

The official simulator exercises the native storage methods with the real SDK, along with the existing reading, import, deletion and table regressions. It closes the native display through the glasses exit path, clears IndexedDB and browser localStorage, then reloads and checks the restored library, reading position and bookmark. [Run evidence](test-results/phone-persistence-passed-20260920/REVIEW.md) describes the tested scenarios and limits. Physical iPhone lifecycle behavior is still a device check; neither Chromium nor the desktop simulator proves the host app's OS storage policy.
