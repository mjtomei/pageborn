# Desktop library OCR

This optional Linux/NVIDIA daemon prepares scanned library PDFs with
[Xiaomi-OCR-0](https://huggingface.co/xiaomi-research/Xiaomi-OCR-0). The phone
keeps its existing OCR implementation and can read without the daemon. A
completed desktop preparation is downloaded when the matching PDF is opened,
then cached on the phone for offline reading. Reopen a document to pick up a
new preparation; a background result never changes the layout while reading.

The daemon uses the same PDF layout, running-header removal, reflow, annotation
gallery and whole-image handling as the glasses reader. Digital PDFs with usable
text keep their embedded text. For scans, Tesseract provides word geometry and
Xiaomi provides a second transcription, using its upstream prompt. A conservative
alignment pass transfers supported word and capitalization corrections onto that
geometry. Unaligned words, tables and figures are preserved. This is not yet a
complete replacement of Tesseract with Xiaomi: missing words without reliable
geometry can remain missing, and ambiguous pages can still fall back to an image.
Raw Xiaomi output is saved with each page for inspection and future improvements.

## Setup

Use a Linux desktop with a supported NVIDIA GPU, Node 22.13+, Python, and a
CUDA-compatible PyTorch installation. These instructions are for the optional
desktop service; they do not install a model on the phone.

1. Install the repository's npm dependencies, including development dependencies,
   and build the worker:

   ```sh
   npm ci
   npm run build:ocr
   npx playwright install chromium
   ```

   An existing Chrome installation can instead be selected with `chromePath` in
   the private config.

2. Create a Python environment outside Git, install the appropriate CUDA PyTorch
   build for your machine, then install `desktop/ocr/requirements.txt`. Download
   the original model, processor and tokenizer files from Xiaomi's model
   repository into a private directory. Retain its `LICENSE` and third-party
   notices. This integration does not redistribute the weights. Model loading
   is local-only; the daemon never downloads weights while processing a PDF.

3. Copy `config.example.json` to `.state/desktop-ocr.json` (Git ignores `.state`).
   Set absolute paths for `libraryDir`, `python` and `modelPath`, and the SHA-256
   of `model.safetensors`. Verify this against the downloaded revision's checksum,
   rather than accepting an unverified download. Start with `batchSize: 1` and
   `gpuMemoryGiB: 4`. Optional `priority` is an array of library filenames.

4. Install the matching `integrations/even-terminal/pageborne-library.js` on your
   existing library server. It adds the authenticated
   `POST /api/pageborne/library/preparation` route. Older servers remain compatible
   with ordinary reading but cannot supply desktop preparations. Build/install
   the Pageborne client from the same revision. No additional phone-facing port
   or credentials are introduced.

5. Copy `pageborne-ocr.service.example` to
   `~/.config/systemd/user/pageborne-ocr.service`, replace its absolute paths,
   and run `systemctl --user daemon-reload`. Start the service manually first:

   ```sh
   systemctl --user start pageborne-ocr
   journalctl --user -u pageborne-ocr -f
   ```

   The service's `flock` prevents duplicate workers. Keep the process memory and
   swap limits. Only enable automatic startup after validating your machine.
   A model failure stops processing and requires an explicit restart; it does
   not repeatedly reload CUDA. To stop: `systemctl --user stop pageborne-ocr`.

## Scheduling, memory and recovery

The service scans the library every 30 seconds. Requested formatting variants
take priority, followed by configured priority documents and recent additions.
It starts new work only below 70% system RAM use with at least 22 GiB physically
free. Separate Node and Python watchdogs stop its own processes at 76% RAM use
or less than 12 GiB physically free, leaving headroom below the 80% ceiling.
Linux `MemAvailable` is used for the utilization measure; the physical-free check
is additional headroom for unified-memory GPUs. The service uses no swap.

Batch size is limited to 1–4, defaulting to 1. The PyTorch allocator defaults to
4 GiB and cannot be configured above 6 GiB. On the tested GB10, batch 4 improved
throughput over 1, but batch 8 regressed and was running during two system freezes.
Larger batches are therefore disabled. These limits reduce risk; neither cgroups
nor the PyTorch allocator can guarantee recovery from a GPU-driver hang or cap
allocations made by other applications.

Completed page results are atomically saved and reused after restart. A failed,
truncated or interrupted inference batch is never published. The original PDF
stays unchanged. The cache identity includes the source bytes, model weights and
processor configuration, worker/preparation code, and requested reading settings.
Changing a PDF or layout format cannot reuse an incompatible preparation.

Derived files live in the library's private `.pageborne/ocr/` directory:

- `daemon.json`: current document, page, phase and heartbeat.
- `<engine>/pages/<source-sha>/<page>.json`: resumable geometry and raw model output.
- `<engine>/prepared/`: completed reader layouts, served in verified chunks.
- `<engine>/failures/`: bounded error descriptions and per-document retry time.
- `telemetry/`: flushed memory samples, rotated at 4 MiB with bounded old logs.

No partial layout is served by this API. Until a complete preparation is ready,
the phone uses its existing progressive OCR. Complete downloads are validated and
cached; an unavailable desktop, corrupt response or changed document falls back
to local reading. Prepared artifacts are limited to 16 MiB.

## Tests

```sh
npm run test:ocr
npm run build:ocr
CHROME_PATH=/path/to/chrome node scripts/desktop-ocr-browser-test.mjs
```

The browser test processes an original synthetic scan, interrupts and resumes
preparation, and downloads the result through the library API into the phone
cache. Its model responses are fixtures: it uses no GPU and is not an OCR
accuracy benchmark. Python tests cover conservative word correction and killing
a child process under simulated memory pressure without allocating excess RAM.
