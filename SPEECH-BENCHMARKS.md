# Local speech comparison · 2026-10-05

**Current app (0.8.41):** Small and the two-model benchmark UI are temporarily removed following phone freezes. This document records historical comparisons. The standalone STT package retains those experiments; current Pageborne uses Tiny only, with a Settings WAV transcription test.

Whisper Small English int8 produced the best transcripts in this small comparison.
Pageborne 0.8.19 used Moonshine Tiny for a quick first draft and Whisper Small for
an optional second pass while the Send/Cancel review stays open. Both run locally;
refinement used CPU/SIMD. Version 0.8.20 now preloads CPU Tiny and GPU Small in
separate resident workers on chat open, and keeps both until app exit. The shared
Settings switch can disable correction work. The packaged hardware test confirms
reuse across papers and cancellation without model eviction, and CPU dictation
when WebGPU is absent. Its whole-browser PSS after both preloads was approximately
3.0–3.2 GiB on this Linux workstation (not incremental model-only memory or a phone
measurement). Actual phone memory pressure remains to be tested.
The model comparison in Settings accepts a WAV file to measure these two models
on the actual phone without sending a question. Version 0.8.24 also records a
sample directly and includes a one-button comparison with bundled audio.

## One-button streaming comparison (0.8.38)

Open **Settings → Voice input → Compare Tiny / Small streaming**. The button is visible without expanding the older accuracy panel; it opens the results automatically. It uses three bundled LibriSpeech clips (5.855 s clean, 17.32 s clean, 7.74 s with deterministic 10 dB noise), sent silently in 100 ms PCM chunks at recording speed. No microphone permission or WAV file is needed. Both models use the production SpeechStream cadence and no vocabulary/reference hints. A preparation wait and one warm-up decode are separate; Tiny and Small run sequentially in alternating order. The comparison takes about a minute plus preparation, warm-up and any inference backlog.

Primary results are **first visible word** from audio start, **audio processing backlog** over the clip, longest gap between text updates, and the remaining wait after audio ends. The 17-second clip crosses the 15-second processing-window boundary. The backlog is captured audio minus the end of the last completed decode, sampled every 100 ms; it is **not exact spoken-word latency**, which would require aligned reference word timestamps. Early/late compares the first/last thirds of each clip. Growing backlog indicates processing falling behind; final word-error scores and text visible at release help distinguish speed from recognition quality. First-word and release times are means; backlog 95th percentile pools valid samples, and longest text gap is the maximum.

Results show preparation/warm-up separately, with per-clip transcripts, word confidence, revisions and full timestamped text/backlog traces in **Save results** JSON. The existing Record a test flow also has **Stream recording** for the same comparison on your own voice. All audio remains local; no question is submitted to an agent.

Tiny stays available while Small downloads. Opening dictation cancels the benchmark wait without cancelling shared preparation; a failed/unavailable GPU still permits CPU results. The test leaves dictation preferences unchanged. Foreground loss cancels the timing run; delayed audio feeds over 500 ms invalidate its timing summary. Cancelling inference retains the resident models. Keep Pageborne visible during the measurement.

Validation: engine unit/API tests, actual-model stream checks, and mocked phone UI tests are distinct. A single prewarmed desktop NVIDIA WebGPU clip produced first-word times 1.17 s (Tiny CPU) / 0.88 s (Small GPU), and release tails 0.53 s / 1.25 s. Both final transcripts had zero word errors. These are not iPhone results or broad accuracy estimates. The real CPU override run only validates the Small streaming path; it is not a GPU performance comparison. Reproduce the phone UI checks with `npm run test:speech:stream-benchmark`, adding `-- --webkit` and `WEBKIT_PATH` for desktop WebKit. Engine script and raw results are in the isolated STT checkout under `scripts/stream-comparison-browser.mjs` and `test-results/stream-comparison-*.json`.

## Benchmark on the phone (0.8.24)

Open **Settings → Voice input → Test voice accuracy and speed**. **Benchmark
voice · included samples** runs nine LibriSpeech clips from four readers, each
clean and with deterministic 10 dB noise (18 tests, 360 reference words). Audio
and CC BY 4.0 attribution are bundled; only correction weights need downloading.

For your voice, read/edit the supplied passage and tap **Record a test**, then
**Stop recording**. Even Hub uses the glasses microphone; a browser uses the
device microphone through Web Audio. Recordings are limited to 60 seconds. You
can replay them, **Save recording** as PCM WAV, or **Compare recording** using
the editable reference. A blank reference gives timings/transcripts without
inventing an accuracy score. Leaving Settings cancels an unfinished recording.

Preparation/download time is shown separately from transcription time. CPU and
GPU process identical audio independently without reference/custom vocabulary
hints. The table shows word-error rates (substitutions + deletions + insertions
divided by reference words), individual model times and their sum: the wait for a
CPU draft followed by GPU correction. Its final accuracy is the GPU result, not
an ensemble. First inference may include kernel warm-up. Scores are weighted by
reference-word count; paired improvement counts use only successful pairs, so a
failed GPU sample cannot improve the apparent comparison. Alignment also counts
errors fixed and introduced. This small corpus is not a population benchmark.

Both models stay resident afterward. Tests do not change dictation preferences
or send agent questions. Audio/results stay in memory until app exit unless
explicitly saved/shared. **Save results** exports timing, model/backend details,
references and transcripts as JSON; this user-requested export is available in
both debug and release builds and is separate from automatic diagnostic logs.

Reproduce UI/capture/cancellation/export checks with `npm run test:speech:benchmark`.
Add `-- --webkit` with `WEBKIT_PATH` for desktop WebKit. The `-- --real` variant
uses the actual packaged models, locally served pinned correction weights, and
an explicit test-only CPU override for Whisper on a shared workstation without
available WebGPU memory. Those timings are not phone/GPU performance measurements.

The 0.8.24 integration run passed all 18 cases using the actual packaged Tiny
and Small fp32/q4 models on desktop CPU/SIMD. Tiny made 30/360 word errors (8.3%);
Small made 12/360 (3.3%), fixing 23 errors and introducing 5. Nine clips improved
and two worsened. Mean times were 0.62 s and 10.57 s, respectively, with Small
explicitly running on CPU for this test. These results validate the benchmark
and illustrate the accuracy tradeoff; they do not predict phone GPU latency.
Evidence: `test-results/speech-phone-benchmark-real-cpu/results.json`. Chrome
and desktop WebKit also passed recording through the real AudioWorklet, native
PCM capture, WAV/JSON exports, cancellation during microphone startup, return
to chat dictation, no-reference scoring and unavailable-GPU handling.

The final 0.8.20 hardware run loaded Tiny in 1.06 seconds and Small in 2.89 seconds.
For the 11-second JFK clip, two warm runs took 0.56–0.63 seconds for the CPU draft
and 0.71–1.01 seconds for GPU correction, with no model reload after a paper change.
Desktop WebKit passed short audio, 36-second segmented audio, silence handling and
the unavailable-GPU fallback. Chrome/WebKit keyboard checks, the native simulator
review/dimming flow, 300 unit tests and debug/release isolation checks also passed.
These results do not establish phone latency or sustained phone memory behavior.
Evidence: `test-results/speech-resident/`, `test-results/speech/webkit-results.json`,
`test-results/ask-review-simulator/` and `test-results/ask-keyboard/`.

## Accuracy and latency

Desktop Linux ARM64, Chrome 154.0.8037.57, single-thread WebAssembly SIMD. Ten
English recordings from five speakers (JFK plus four LibriSpeech speakers), each
run clean and with deterministic 10 dB uniform noise. This gives 20 cases per
model, 100 transcriptions total, 404 reference words per model. Mean audio length
was 8.22 seconds. Files/references and pinned model revisions are in
`vendor/stt/benchmark-samples.json` and `vendor/stt/benchmark-models.json`.

| Model / quantization | Model assets, MB | Mean transcription | First model load* | Clean WER | Noisy WER | Combined WER |
|---|---:|---:|---:|---:|---:|---:|
| Moonshine Tiny, fp32 encoder / q4 decoder (current) | 79.4 | 0.49 s | 0.91 s | 4.5% | 10.9% | 7.7% |
| Moonshine Base, fp32 encoder / q4 decoder | 157.5 | 1.27 s | 1.18 s | 3.5% | 8.4% | 5.9% |
| Moonshine Base, int8 | 66.9 | 0.62 s | 1.09 s | 3.5% | 11.9% | 7.7% |
| Whisper Base English, int8 | 79.6 | 2.31 s | 0.87 s | 4.5% | 7.9% | 6.2% |
| Whisper Small English, int8 | 251.8 | 8.22 s | 1.53 s | 2.0% | 3.5% | 2.7% |

MB is decimal. Assets include the files actually used by that profile, not every
precision variant in its repository. q4 is not always the smallest exported file:
these exports keep different amounts of unquantized data.

\*Load includes model files served locally and session creation in a fresh worker;
it excludes an internet download and may benefit from OS/browser/runtime caches.
Transcription includes audio processing/inference, not Playwright transport or
loading. Models use identical bounded 15-second segmentation and greedy decoding.
WER ignores punctuation/case and treats “Mr.” and “Mister” equivalently. Mean
inference ranges were 0.20–0.96 s for Tiny and 6.99–14.98 s for Whisper Small.

Whisper Small corrected “rose beef” to “roast beef” and handled some names/noisy
speech better, but occasionally introduced errors too. It is not a guarantee of
an improved individual question. Users always approve the draft before sending.

These are development-machine measurements, not iPhone/Android latency or battery
measurements. The set is small and mostly read English; artificial noise is not
real glasses microphone noise. Long/difficult technical questions and phone
memory limits still need device testing. The machine was not reserved exclusively
for benchmarks, so treat timings as indicative rather than fine-grained rankings.

## Keeping models loaded

Measured Linux proportional resident memory (PSS), summed across the dedicated
benchmark browser's processes. PSS avoids counting shared pages repeatedly.
After one real transcription, a main-page GC request and brief idle, added PSS
relative to the empty-browser baseline before each load was approximately:

| Model | Added resident RAM |
|---|---:|
| Moonshine Tiny | 602 MiB |
| Moonshine Base fp32/q4 | 818 MiB |
| Moonshine Base int8 | 485 MiB |
| Whisper Base English int8 | 538 MiB |
| Whisper Small English int8 | 1,115 MiB |

Models were kept in separate workers; previous workers were terminated for the
individual measurements. Worker garbage collection and engine buffer retention
make these approximate, post-inference figures—not minimum weights-only memory,
peak memory, or iPhone WebKit allocations. Desktop development module/runtime
loading is included; the packaged build and WebKit can differ.

Keeping **all five** workers alive used about **2.93 GiB additional PSS**. Keeping
just **Tiny and Whisper Small** alive used about **1.65 GiB additional PSS**.
Model bytes alone total about 635 MB for all five, or 331 MB for the chosen pair.
The idle probes used zero to 0.1 CPU-seconds over three seconds across the whole
browser. No inference runs while idle; sustained RAM use is the main cost, while
running the larger model costs computation and battery. This is not a battery
benchmark.

Version 0.8.19 terminated Tiny's worker before loading the refinement model,
and terminated refinement after completion or cancellation. Version 0.8.20 changes
that policy at the user's request: both stay resident for the app session, including
between papers. The first draft remains reviewable while
refinement loads/runs. Edits, Send, Cancel, a new recording, document changes and
leaving Ask invalidate late results. A failure keeps the first draft.

## Hardware WebGPU trial

NVIDIA GB10, driver 580.178.04, Chrome 154 on Linux ARM64. The adapter reported
`vendor: nvidia`, `fallback: false`. One 11-second JFK recording was transcribed
twice per model, first in a fresh worker and then reusing the model. These are
feasibility/cold-versus-warm measurements, not a full GPU accuracy comparison.

| Model | Assets, MB | Fresh load | First inference | Reused inference |
|---|---:|---:|---:|---:|
| Moonshine Tiny fp32/q4 | 79.4 | 1.57 s | 1.39 s | 0.24 s |
| Whisper Small English fp32/q4 | 588.7 | 2.73 s | 1.07 s | 0.65 s |
| Whisper Large-v3 Turbo q4 | 761.9 | 3.17 s | 1.47 s | 0.96 s |

Each successful transcript had zero word errors on this single clip. Model load
and inference are separate, additive costs; they exclude benchmark audio transfer
and network download. GPU Small uses different precision from CPU Small above.
These are desktop GPU measurements, not predictions of iPhone performance.

Medium English fp32/q4 failed to create its inference session (opaque ORT error
`9950264`). An all-q4 Medium export was prepared for a retry, but subsequent
hardware trials could no longer allocate the GPU adapter. The NVIDIA kernel log
reported `NV_ERR_NO_MEMORY` during graphics-context allocation. Other workloads
were running on this shared machine; this does not establish that Medium is
unsupported. Later attempts fell back to software rendering or returned no
adapter. Software results were excluded, and the benchmark now rejects fallback.
No reliable full-corpus GPU run or Medium GPU timing is available.

The successful raw measurements are in
`test-results/speech-models/webgpu-cold-warm.json`. GPU candidate revisions and
checksums are pinned in `vendor/stt/gpu-benchmark-models.json`; these models are
not included in the app package. The manifest uses q4 Medium for the next trial,
so it no longer downloads the unsuccessful 1.23 GB fp32 encoder by default.

### Loading while recording

In 0.8.19, `AskUI.hold()` started recording; loading began in `release()` after
recording stopped. The exception was an already-warm worker, including use of
**Prepare voice** beforehand. Version 0.8.20 begins both preloads at chat open,
including when holding to speak opens the chat. The earlier first-use delay could include non-overlapped
loading as well as first-inference setup. Beginning preparation at microphone
start could hide much of the load time. A warm-up inference would also be needed
to hide first-inference kernel setup; loading weights alone does not do that.
Preloading both the fast and refinement models would increase peak memory, so it
needs separate phone testing given the existing memory measurements.

## Confidence and uncertain words

Transformers.js 4.3.0 documents `output_scores`, but the installed generation
implementation does not return them. The comparison uses a non-mutating
`LogitsProcessorList` hook to collect the greedy token's probability after default
decoding filters. These are conditional model scores, not calibrated probabilities
that a word or sentence is correct. They are not the same metric as native
Whisper's `avg_logprob` or `no_speech_prob`.

Forty CPU transcriptions completed: Tiny and Small on all 20 clean/noisy cases,
with no inference errors. Token sequences were decoded and checked against the
actual transcript, grouped into complete words, and aligned with the reference
using the same word-error normalization. Punctuation-only tokens were excluded
from word scores. Word confidence below means the minimum constituent-token score.

| Model | Incorrect emitted words | Flagged below 0.50 | Errors caught | Correct words also flagged | Deleted words |
|---|---:|---:|---:|---:|---:|
| Moonshine Tiny | 29 / 407 | 29 | 17 | 12 | 2 |
| Whisper Small English int8 | 9 / 402 | 10 | 7 | 3 | 2 |

Examples from Tiny: incorrect **rose** for *roast* scored 0.434; the `oter` part
of **Quoter** for *Quilter* scored 0.279; the first part of **Coulter's** for
*Quilter's* scored 0.429. These support dimming entire uncertain words while a
refinement is pending. But incorrect **school** for *sleep* scored 0.781 and
incorrect **efforts** for *effort* scored 0.975. Correct uncommon names can score
low, and omitted words have no output token to highlight. A threshold of 0.80
caught 26 of Tiny's 29 emitted errors, but also flagged 57 correct words.

Sentence averages obscure these cases: three of eight Tiny transcripts with
mean token score at least 0.90 still had word errors. Per-word scores are useful
as a tentative display hint, not as automatic approval or a guarantee that bright
words are correct. The set is too small for threshold calibration; these figures
are exploratory on the same corpus, not held-out evaluation. Raw scores should
not be directly compared between models.

The phone can style individual words. Even SDK 0.0.14+ adds `textColor` brightness
levels 0–4, but this applies to a whole text container, not spans within it. Per-word
dimming in native glasses text would require a different layout; it cannot be
applied inline to the existing single-container review paragraph. Version 0.8.20
implements phone word dimming below minimum-token score 0.90 and dims the native
review container while correction is pending and uncertain words are present.
It never blocks Send based on a score. GPU results replace the phone word scores;
manual editing clears them. No source audio or word scores enter diagnostics.

Raw results: `test-results/speech-models/confidence-results.json`; word alignment,
examples and threshold counts: `test-results/speech-models/word-confidence.json`.
The analysis script also generates `word-confidence-thresholds.md` and `.csv` in
that directory. They compare arithmetic-average and minimum-token word scores
from 0.10 through 0.99, with specificity (correct words left unflagged), selectivity
(precision: flagged words actually wrong), and sensitivity (emitted errors caught).
The CSV includes TP/FP/FN/TN counts; the JSON retains geometric-mean results too.
At 0.50, Tiny's arithmetic average flags 12 wrong and 10 correct words (41.4%
error recall, 97.4% specificity); minimum flags 17 wrong and 12 correct words
(58.6% error recall, 96.8% specificity).

## Larger open models

[Whisper](https://github.com/openai/whisper) includes Medium (769M parameters),
Large-v3 Turbo (809M) and Large-v3 (1.55B). Other open model families include
[Qwen3-ASR 1.7B](https://huggingface.co/Qwen/Qwen3-ASR-1.7B) and
[Voxtral Mini 4B Realtime](https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602).
Their existence does not establish browser/phone feasibility or an accuracy
improvement for this use. Only the Whisper GPU profiles above were attempted;
Qwen and Voxtral were not benchmarked or integrated into Pageborne.

One comparable [eight-dataset English evaluation](https://huggingface.co/datasets/Steveeeeeeen/whisper-leaderboard-evals/blob/refs%2Fpr%2F1/20_nov_24_latest.csv)
reports the following Transformers/CUDA results. These published desktop
measurements do not establish the accuracy of our quantized browser exports.

| Model | Mean WER ↓ | Relative error reduction vs Small.en |
|---|---:|---:|
| Small.en (244M) | 8.59% | — |
| Medium.en (769M) | 8.09% | 5.8% |
| Large-v3 Turbo (809M) | 7.83% | 8.8% |
| Large-v3 (1.55B) | 7.44% | 13.4% |

Harder subsets can benefit more: LibriSpeech Other reports 7.25%, 5.85%, 4.24%
and 3.91%, respectively. Newer leaderboard averages use different datasets;
do not compare their averages directly against Small's 8.59%. The existing
desktop WebGPU experiment above establishes that Turbo can run in our browser
stack, but its one-clip accuracy result and desktop latency are insufficient to
choose it as the phone default.

## Reproducing

With the repo's Node 22 environment:

```sh
node scripts/speech-model-benchmark.mjs
node scripts/speech-model-benchmark.mjs --memory
node scripts/speech-model-benchmark.mjs --memory-single
node scripts/speech-model-benchmark.mjs --memory-pair
node scripts/speech-model-benchmark.mjs --webgpu --large --quick
node scripts/speech-model-benchmark.mjs --confidence
node scripts/speech-confidence-analysis.mjs
```

The script fetches pinned, checksummed model assets and public audio fixtures if
missing. JSON reports are written under `test-results/speech-models/`. Run the
latency comparison without other compute-intensive work for more stable timings.
Memory tests require Linux `/proc` and Chrome. These test-only candidate models
are not all packaged in Pageborne; release uses only Tiny and Whisper Small (Small weights download separately as of 0.8.23).
The GPU launch configuration targets this NVIDIA/Linux workstation and rejects
non-NVIDIA/fallback adapters. `--headed` uses its GDM display; leave it off for
headless runs. `--quick` writes a separate `*-quick.json` report so it does not
overwrite the corpus results. The word-confidence analysis needs only local
tokenizers and saved confidence results; it does not rerun inference.

Model sources: [Moonshine Base ONNX](https://huggingface.co/onnx-community/moonshine-base-ONNX),
[Whisper Base English ONNX](https://huggingface.co/onnx-community/whisper-base.en),
[Whisper Small English ONNX](https://huggingface.co/onnx-community/whisper-small.en).
GPU sources: [Medium English ONNX](https://huggingface.co/Xenova/whisper-medium.en),
[Large-v3 Turbo ONNX](https://huggingface.co/onnx-community/whisper-large-v3-turbo).
Confidence reference: [Whisper transcription implementation](https://github.com/openai/whisper/blob/main/whisper/transcribe.py).
Display reference: [official Even SDK changelog](https://www.npmjs.com/package/@evenrealities/even_hub_sdk).
