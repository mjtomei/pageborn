# Pageborne

A reader for Even G2 glasses.

- Markdown, plain text and PDF documents
- Hold to speak a question, transcribed on the device ([how it works](https://github.com/mjtomei/browser-stt)), and keep a conversation about what you are reading going in the background
- PDF body text reflowed into native glasses text
- Markdown tables restacked one row at a time for the narrow display
- Figures and tables from PDFs in a gallery on your phone
- Timed autoscroll and speed reading
- An experimental phone/iPad web reader that shares the desktop library and conversations

## Reading and conversations

G2 supports native text, PDF reflow/figures, page reading, timed autoscroll and speed reading.

Ask connects to a desktop session you configure; direct API connections are experimental. Optional extensions from the separate [even-terminal-patch](https://github.com/mjtomei/even-terminal-patch) repository add the shared library, conversation histories and passage links to a desktop Terminal server. Claude and Codex keep separate histories for each document. The standard G2 reader can import local Markdown, text and PDF files and read without a desktop connection.

## Build

Use Node **22.13+** and npm. No private server or credentials are needed to build.

```sh
npm ci
npm test
npm run build          # public/release profile, no private pairing preset
npm run pack           # creates even-reader.ehpk from the release profile
```

Install the package using your Even Hub development/publishing workflow. `app.json` retains the existing application identity so private updates remain compatible; choose your own identity before publishing an independent Hub listing. Branding assets are in [branding/](branding/README.md).

Model weights download on first voice setup (about 249 MB total) and are cached on the device. Inference runtime assets ship with the application. npm fetches a pinned [Browser STT](https://github.com/mjtomei/browser-stt) source revision and builds its workers during installation; no speech-engine tarball is stored here. See [speech package notes](SPEECH-PACKAGE.md). [Third-party notices](LICENSING.md) list the terms for the downloaded models and bundled runtimes.

## Configuring for a custom Even Terminal

If you run the custom Even Terminal from the [even-terminal-patch](https://github.com/mjtomei/even-terminal-patch) repository, this is where its connection settings go. Copy the example to **`.env.local`**, which Git ignores, and put your deployment settings there:

```sh
cp .env.example .env.local
# Edit .env.local with your own origins and paths.
npm run build:debug    # explicit private profile
npm run pack:debug     # private package; can embed the configured pairing token
npm run build:web      # phone/iPad web frontend
npm run start:web      # reads .env.local; serves the authenticated web reader
```

Release builds ignore all private debug connection presets, even when `.env.local` exists. Only explicitly configured `PAGEBORNE_RELEASE_ASK_ORIGINS` extend the release network allowlist; users enter their endpoint and token in the app. Runtime web credentials stay on the companion server. **Do not distribute a private debug package.**

[Configuration](CONFIGURATION.md) covers the network allowlist, private pairing, web server and Tailscale setup. [Compatibility](COMPATIBILITY.md) distinguishes standard reading, optional custom Terminal extensions and experimental adapters. [Ask details](ASK-ABOUT-THIS.md) and [PDF details](PDF-READING.md) include implementation notes and historical changes.

## Checks and GitHub preparation

```sh
npm run release:audit
npm run build:debug
npm run test:build-profiles  # Chromium; CHROME_PATH may override its executable
npm run test:web            # Chromium and WebKit; WEBKIT_PATH may override WebKit
# After committing a clean reviewed tree:
npm run release:export -- /path/outside/repo/pageborne-source.tar.gz
```

The export contains the committed source for all build profiles, with no Git history, local config, pairing credentials, models, user documents or built debug packages. Existing development history is not included. The audit checks known private deployment markers and sensitive file types; it is not a general secret-detection guarantee.
