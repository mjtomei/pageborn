# Pageborne branding assets

Name: **Pageborne**

Subheading: **Markdown and PDFs, on your glasses.**

The 0.7.1 manifest, phone interface, browser title and fallback glasses title use this name. Keep the existing `local.even.reader` project/package ID when uploading the update. This preserves the app identity and its saved library.

- `pageborne-icon.png`: 512 × 512 composite, white book on black.
- `pageborne-icon-foreground.png`: 512 × 512 white symbol on transparency.
- `pageborne-icon-background.png`: 512 × 512 opaque black background.
- `pageborne-hub-icon.svg` and `.png`: 24 × 24 menu icon, adapted to the Hub's minimum 2 × 2 filled-block requirement.
- Matching SVG sources are resolution-independent and use only black and white.

The 512-pixel PNGs were rendered directly from the SVG sources in Chromium. All visible RGB pixels were checked for equal red, green and blue values. The foreground has transparency; the composite and background are opaque. The foreground SVG is used in the phone library header and the composite SVG is the browser icon.

On 2026-10-20, the existing `local.even.reader` Hub listing was renamed from Even Reader to Pageborne and given the 24-pixel book icon. The Hub version has transparent background, solid monochrome pixels and a thicker folded-page edge for the menu's small size. It was entered through the Hub icon editor, passed its minimum-block validation, and the editor's PNG export is saved here. The larger app/browser artwork remains unchanged. This listing update uses the same package identity and Beta build 0.8.113.

Release note: Renamed to Pageborne with a new book icon. Read local Markdown, text and PDFs on your glasses, with paging, adjustable autoscroll and a phone document browser.

## Design provenance

Initial concepts used the built-in image-generation tool (no CLI/API fallback). The raster concepts had rough edges, so the final icon was drawn as original SVG geometry using the same open-book/folded-page idea. The generated raster files are not used in the SVGs or PNG exports.

Concept prompt: a centered, minimal folded-page symbol suggesting an open book; bold white silhouette with generous black negative space on a flat black square; legible at 32 pixels; no text, branding, color, texture, gradients or shadows.

Final vector specification: two white pages with an open center gutter, curved top and bottom edges, and a folded upper-right corner; centered within a 1024-unit square. The foreground and background can be uploaded separately if the Hub requests separate layers.
