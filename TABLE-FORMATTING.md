# Tables on a small native-text display

Version 0.4.1 renders GitHub-flavored Markdown tables as stacked records on the glasses and in the phone's **Read from here** pane. Each record repeats the column names, so their meaning survives a page turn or a phone jump. Long cells wrap; no value is truncated to fit a column.

For example:

```markdown
| Feature | Status | Notes |
| --- | --- | --- |
| Pages | Ready | Read a full screen per swipe. |
| Autoscroll | Ready | Adjust speed with a swipe. |
```

becomes:

```text
Table (2 rows)

[1/2] Feature: Pages
  Status: Ready
  Notes: Read a full screen per swipe.

[2/2] Feature: Autoscroll
  Status: Ready
  Notes: Adjust speed with a swipe.
```

Continuation lines have four spaces of indentation. Blank cells show `(empty)`; unnamed columns get `Column N`, and duplicate names include the column number. A table with headers only keeps its labels and shows `(no rows)`. Inline links, emphasis and code retain their readable text, escaped pipes stay inside their cells, and `<br>` creates a line break without rendering arbitrary HTML. Plain `.txt` files remain literal text.

## Existing approaches examined

Research checked September 20, 2026:

- [Glamour](https://github.com/charmbracelet/glamour), used by Glow and GitHub CLI, renders Markdown with configurable word wrapping for ANSI terminals. Its Go runtime and terminal styling are not a direct fit for the browser app or G2 native-text container.
- [marked-terminal](https://github.com/mikaelbr/marked-terminal) provides a terminal renderer for Marked; [Rich](https://rich.readthedocs.io/en/stable/tables.html) auto-sizes and wraps terminal table columns. These are useful grid-layout references, but terminal cell alignment differs from the proportional font used here.
- [mdpad](https://www.lpalbou.info/mdpad/introduction.html) explicitly falls back to per-row records when a table cannot fit a terminal grid.
- [Tablesaw Stack Mode](https://github.com/filamentgroup/tablesaw#stack-mode) repeats headers beside cells at narrow viewport widths. Its HTML/jQuery plugin is archived, so this app adapts the presentation pattern instead of adding that dependency.

The implementation reuses the installed **Marked** parser for table and inline tokens, **Even pretext** for native font measurements, and the existing wrapping and navigation code. No code from the above renderers was copied and no new runtime dependency was added.

The G2 viewport shows nine native text rows. Its font is proportional, and text updates must also respect the simulator's byte limit. These constraints favor one consistent record format over padded grids whose column headers can scroll away. The tradeoff is that tables occupy more vertical space. A long cell can span pages; each page continues at the next unread row with zero configured overlap.

## Navigation and verification

Each record keeps its original Markdown source line and each displayed row retains a character offset. Artificial field breaks do not inflate source-line numbers. Search and bookmarks target the matching cell or continuation line. When old paragraph-style table text no longer matches, an existing bookmark can fall back to that table's original source row. The imported Markdown content is never rewritten.

`test/tables.test.js` covers cell parsing, blank and duplicate headers, header-only tables, Unicode, long words, pixel/byte limits, page coverage at every overlap setting, cell search and saved positions. Both layout paths use the same block formatter.

The browser suite imports [the example table](test/fixtures/tables.md), selects a record, searches a multiline cell, saves and reopens its bookmark, and checks all three phone text sizes at 360px and 430px widths. The official simulator regression records the table, forward/backward page swipes and sequential autoscroll through its fields. See [the reviewed run](test-results/tables-20260920/REVIEW.md).

The September 21 stress tests add a 2,000-row × 8-column table (18,029 display rows), a 40-column table with long headers, and cells containing 137,828 characters of prose, a 64,026-character unbroken token, and mixed Chinese, accented text and emoji. Layout assertions reconstruct every record, check pixel/byte bounds and cover every page at all nine overlap settings. Browser checks exercise search, page turns, bookmarks/reopening and bounded phone DOM at 320/390/430px widths and all three fonts. The official simulator records these cases using `--table-stress`, including autoscroll within the large prose cell. See [stress evidence](test-results/table-stress-verified-20260921/REVIEW.md). Missing font glyphs, such as some emoji, remain a native-font limitation; preserving their text does not make the glyphs available on the glasses.
