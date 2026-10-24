import samples from '../vendor/stt/benchmark-samples.json';
import { version } from '../package.json';
import { runSpeechBenchmark, summarizeSpeech } from './speech-benchmark.js';
import { runStreamingSpeechBenchmark, summarizeStreamingSpeech } from '@pageborne/browser-stt/speech-stream-benchmark';
import { SpeechRecording } from './speech-recording.js';
import { safeTimeout, cancelTimeout } from './timers.js';

const $ = id => document.getElementById(id);
const seconds = ms => ms == null ? '—' : `${(ms / 1000).toFixed(2)} s`;
const percent = value => value == null ? '—' : `${(value * 100).toFixed(1)}%`;
const passage = "Please explain the difference between correlation and causation. How does Bayesian inference update a belief when new evidence arrives, and what would count as a counterexample to the author's argument?";
const node = (tag, text) => { const el = document.createElement(tag); el.textContent = text; return el; };

async function saveFile(file) {
  if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }); return; }
  const url = URL.createObjectURL(file), link = document.createElement('a');
  link.href = url; link.download = file.name; document.body.append(link); link.click(); link.remove();
  safeTimeout(() => URL.revokeObjectURL(url), 60000);
}

export class SpeechBenchmarkUI {
  constructor(speech, microphone) {
    this.speech = speech;
    this.recorder = new SpeechRecording(microphone, () => this.busy(!!speech.job));
    $('speech-stream-benchmark').onclick = () => {
      $('speech-benchmark-panel').open = true;
      this.runStreaming([0, 5, 7].map((index, i) => ({
        id: `${samples[index].file}:${i === 2 ? 'noise' : 'clean'}`, label: `Clip ${i + 1} · ${i === 2 ? 'added noise' : 'clean'}`,
        reference: samples[index].reference, noisy: i === 2,
        audio: async signal => {
          const response = await fetch(new URL(`stt/benchmark/${samples[index].file}`, document.baseURI), { signal });
          if (!response.ok) throw new Error(`Could not load test clip: HTTP ${response.status}`);
          return response.blob();
        },
      })), 'bundled');
    };
    this.onVisibility = () => {
      if (document.hidden && this.streamingSignal && !this.streamingSignal.aborted) {
        this.speech.cancel(); this.speech.status('Streaming test cancelled when the app left the foreground. Run again with the app visible.');
      }
    };
    document.addEventListener('visibilitychange', this.onVisibility);
    $('speech-benchmark-cancel').onclick = () => $('speech-cancel').click();
    $('speech-benchmark').onclick = () => this.run(samples.flatMap((sample, index) => [false, true].map(noisy => ({
      id: `${sample.file}:${noisy ? 'noise' : 'clean'}`, label: `Clip ${index + 1} · ${noisy ? 'added noise' : 'clean'}`, noisy, reference: sample.reference,
      audio: async signal => {
        const response = await fetch(new URL(`stt/benchmark/${sample.file}`, document.baseURI), { signal });
        if (!response.ok) throw new Error(`Could not load test clip ${index + 1}: HTTP ${response.status}`);
        return response.blob();
      },
    }))), 'bundled');
    $('speech-record').onclick = () => this.recorder.active ? this.recorder.stop() : this.record();
    $('speech-record-reference').value = passage;
    $('speech-record-compare').onclick = () => {
      if (!this.audio) return;
      const audio = this.audio;
      this.run([{ id: 'recording', label: 'Your recording', reference: $('speech-record-reference').value, audio: async () => audio }], 'recording');
    };
    $('speech-record-stream').onclick = () => {
      if (!this.audio) return;
      const audio = this.audio;
      this.runStreaming([{ id: 'recording', label: 'Your recording', reference: $('speech-record-reference').value, audio: async () => audio }], 'recording');
    };
    $('speech-record-save').onclick = () => this.export(() => saveFile(new File([this.audio], 'pageborne-voice-test.wav', { type: 'audio/wav' })));
    $('speech-results-save').onclick = () => this.export(() => saveFile(new File([JSON.stringify(this.report, null, 2)], `pageborne-voice-benchmark-${new Date().toISOString().slice(0, 10)}.json`, { type: 'application/json' })));
    this.busy(false);
  }
  busy(value) {
    $('speech-benchmark').disabled = value;
    $('speech-stream-benchmark').disabled = value;
    $('speech-benchmark-cancel').hidden = !value;
    $('speech-record').disabled = value && !this.recorder.active;
    $('speech-record').textContent = this.recorder.active ? 'Stop recording' : 'Record a test';
    $('speech-record').setAttribute('aria-pressed', String(this.recorder.active));
    $('speech-record-compare').disabled = value || !this.audio;
    $('speech-record-stream').disabled = value || !this.audio;
    $('speech-record-save').disabled = !this.audio;
    $('speech-results-save').disabled = value || !this.report;
  }
  record() {
    return this.speech.task(async (signal, progress) => {
      $('speech-record-playback').pause();
      const audio = await this.recorder.start(signal, progress); signal.throwIfAborted();
      this.audio = audio;
      if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
      this.audioUrl = URL.createObjectURL(audio);
      $('speech-record-playback').src = this.audioUrl; $('speech-record-playback').hidden = false;
      progress('Recording ready. Check the reference matches what you said, then tap Compare recording.');
    });
  }
  run(clips, source) {
    return this.speech.task(async (signal, progress) => {
      cancelTimeout(this.renderTimer); this.renderTimer = null; this.reportOwner = signal;
      this.report = null; $('speech-benchmark-output').replaceChildren();
      const metadata = { version, startedAt: new Date().toISOString(), userAgent: navigator.userAgent, source,
        method: 'Same audio, independent CPU and GPU transcripts; no custom vocabulary. Preparation excluded from inference timing. Sequential CPU + GPU is time to the corrected result, not an ensemble.' };
      try {
        await runSpeechBenchmark({ samples: clips, models: this.speech.models, signal,
          progress: (text, stage) => { this.speech.preparing = stage === 'prepare' ? 'benchmark' : false; progress(text); },
          update: report => { if (!signal.aborted) { this.report = { ...metadata, ...report, ...(report.completed ? { finishedAt: new Date().toISOString() } : {}) }; this.render(); } },
        });
        progress('Benchmark finished. Recordings and results stay on this device unless you save or share them.');
      } finally {
        this.speech.preparing = false;
        if (signal.aborted && this.report?.startedAt === metadata.startedAt) { this.report.cancelled = true; this.render(); }
      }
    });
  }
  runStreaming(clips, source) {
    return this.speech.task(async (signal, progress) => {
      cancelTimeout(this.renderTimer); this.renderTimer = null;
      this.streamingSignal = this.reportOwner = signal; this.report = null; $('speech-benchmark-output').replaceChildren();
      const metadata = { version, startedAt: new Date().toISOString(), userAgent: navigator.userAgent, source,
        method: 'Same audio paced in 100 ms PCM chunks through SpeechStream (500 ms minimum new audio, 100 ms coalescing). Independent prewarmed Tiny CPU and Small GPU runs; alternating order. No vocabulary/reference hints. Model preparation and warm-up excluded. First-word time starts at audio onset; release delay starts after the last audio chunk. Backlog is captured audio minus the end of the last completed decode, sampled every 100 ms; early/late are the first/last thirds. This measures processing backlog, not precisely aligned spoken-word lag. No microphone/Bluetooth latency is measured. Timings excluded when audio delivery is delayed by more than 500 ms.' };
      try {
        await runStreamingSpeechBenchmark({ samples: clips, models: this.speech.models, signal,
          progress: (text, stage) => { this.speech.preparing = stage === 'prepare' ? 'benchmark' : false; progress(text); },
          update: report => {
            if (signal.aborted) return;
            this.report = { ...metadata, ...report, summary: summarizeStreamingSpeech(report.runs), ...(report.completed ? { finishedAt: new Date().toISOString() } : {}) };
            if (report.completed) { cancelTimeout(this.renderTimer); this.renderTimer = null; this.render(); }
            else if (!this.renderTimer) this.renderTimer = safeTimeout(() => { this.renderTimer = null; if (this.reportOwner === signal) this.render(); }, 100);
          },
        });
        progress('Streaming comparison finished. Save results to share the timings and transcripts.');
      } finally {
        if (this.reportOwner === signal) {
          this.speech.preparing = false; this.streamingSignal = null; cancelTimeout(this.renderTimer); this.renderTimer = null;
          if (signal.aborted && this.report) { this.report.cancelled = true; this.report.active = null; }
          if (this.report) this.render();
        }
      }
    });
  }
  render() {
    if (this.report?.kind === 'streaming') { this.renderStreaming(); return; }
    const report = this.report, output = $('speech-benchmark-output'); output.replaceChildren();
    output.append(node('p', report.completed ? `Finished · ${report.runs.length} tests` : `${report.cancelled ? 'Cancelled' : 'In progress'} · ${report.runs.length} tests finished`));
    for (const [model, name] of [['fast', 'CPU draft'], ['refine', 'GPU correction']]) {
      const row = report.prepared[model]; if (!row) continue;
      output.append(node('p', row.error ? `${name}: ${row.error}` : `${name} preparation: ${row.alreadyReady ? 'already loaded' : seconds(row.waitMs)}${row.backend ? ` · ${row.backend}` : ''}`));
    }
    if (!report.runs.length) return;
    const summary = summarizeSpeech(report.runs), table = document.createElement('table');
    table.append(node('caption', 'Accuracy and response time'));
    const head = document.createElement('thead'), headings = document.createElement('tr');
    for (const label of ['Result', 'Word errors ↓', 'Mean time']) { const th = node('th', label); th.scope = 'col'; headings.append(th); }
    head.append(headings); table.append(head); const body = document.createElement('tbody');
    for (const [label, wer, ms, count] of [
      ['CPU draft', summary.fast.wer, summary.fast.meanMs, summary.fast.count],
      ['GPU correction', summary.refine.wer, summary.refine.meanMs, summary.refine.count],
      ['Draft + correction', summary.paired.finalWer, summary.paired.meanMs, summary.paired.count],
    ]) {
      const tr = document.createElement('tr'), th = node('th', `${label} (${count})`); th.scope = 'row';
      tr.append(th, node('td', percent(wer)), node('td', seconds(ms))); body.append(tr);
    }
    table.append(body); output.append(table);
    const paired = summary.paired;
    output.append(node('p', `Matched tests: ${paired.count}. CPU ${percent(paired.draftWer)} → GPU ${percent(paired.finalWer)} word errors. ${paired.fixed} errors fixed, ${paired.introduced} introduced; ${paired.improved} clips improved, ${paired.worsened} worsened.`));
    if (report.source === 'bundled') for (const noisy of [false, true]) {
      const group = summarizeSpeech(report.runs.filter(row => row.noisy === noisy)).paired;
      output.append(node('p', `${noisy ? 'Added noise (10 dB)' : 'Clean audio'}: CPU ${percent(group.draftWer)} → GPU ${percent(group.finalWer)} word errors (${group.count} paired tests).`));
    }
    output.append(node('p', 'Lower word-error rate is better; it counts wrong, missing and extra words. — means unavailable or no reference. Times start after recording and model preparation; the first run can include warm-up. Draft + correction shows the earlier CPU draft, then the same GPU result. This small test is not a general accuracy benchmark.'));
    const details = document.createElement('details'); details.append(node('summary', 'Transcripts and individual times'));
    for (const row of report.runs) {
      details.append(node('h5', `${row.label} · ${row.seconds.toFixed(1)}s audio`), node('p', `Reference: ${row.reference || '(None — timing only)'}`));
      for (const [model, name] of [['fast', 'CPU draft'], ['refine', 'GPU correction']]) {
        const run = row[model];
        details.append(node('p', `${name}: ${!run ? 'unavailable' : run.error || `${seconds(run.ms)} · ${percent(run.score?.wer)} word errors\n${run.text || '(No speech)'}`}`));
      }
    }
    output.append(details);
  }
  renderStreaming() {
    const report = this.report, output = $('speech-benchmark-output'); output.replaceChildren();
    output.append(node('p', `${report.completed ? 'Finished' : report.cancelled ? 'Cancelled' : 'In progress'} · Streaming comparison`));
    if (report.active) {
      output.append(node('p', `${report.active.model === 'fast' ? 'Tiny · CPU' : 'Small · GPU'} · ${report.active.label}${report.active.finishing ? ' · Finishing…' : ''}`));
      const live = node('pre', report.active.text || 'Waiting for first words…'); live.id = 'speech-stream-live'; output.append(live);
    }
    for (const [model, name] of [['fast', 'Tiny'], ['refine', 'Small']]) {
      const row = report.prepared[model], warmup = report.warmup[model];
      if (row?.error || warmup?.error) output.append(node('p', `${name}: ${row?.error || warmup.error}`));
    }
    const summary = summarizeStreamingSpeech(report.runs), table = document.createElement('table');
    table.append(node('caption', 'Streaming on this device'));
    const head = document.createElement('thead'), headings = document.createElement('tr');
    for (const title of ['Measurement', 'Tiny · CPU', 'Small · GPU']) { const th = node('th', title); th.scope = 'col'; headings.append(th); }
    head.append(headings); table.append(head); const body = document.createElement('tbody');
    for (const [title, format] of [
      ['First words · mean', model => seconds(summary[model].firstWordMs)],
      ['After speech · mean', model => seconds(summary[model].releaseMs)],
      ['Audio backlog · 95th %', model => seconds(summary[model].backlogP95Ms)],
      ['Backlog early → late', model => `${seconds(summary[model].backlogEarlyMs)} → ${seconds(summary[model].backlogLateMs)}`],
      ['Backlog at speech end', model => seconds(summary[model].backlogAtReleaseMs)],
      ['Longest text gap', model => seconds(summary[model].maxUpdateGapMs)],
      ['Word errors', model => percent(summary[model].wer)],
      ['Updates / clip', model => summary[model].updateCount?.toFixed(1) ?? '—'],
      ['Revisions / clip', model => summary[model].revisions?.toFixed(1) ?? '—'],
      ['Valid timing runs', model => `${summary[model].timedCount} / ${summary[model].count}`],
      ['Preparation', model => report.prepared[model]?.alreadyReady ? 'Ready' : seconds(report.prepared[model]?.waitMs)],
      ['Warm-up', model => seconds(report.warmup[model]?.ms)],
    ]) {
      const tr = document.createElement('tr'), th = node('th', title); th.scope = 'row';
      tr.append(th, node('td', format('fast')), node('td', format('refine'))); body.append(tr);
    }
    table.append(body); output.append(table);
    const details = document.createElement('details'); details.append(node('summary', 'Transcripts and individual times'));
    for (const row of report.runs) {
      details.append(node('h5', row.label), node('p', `Reference: ${row.reference || '(None — timing only)'}`));
      for (const [model, name] of [['fast', 'Tiny · CPU'], ['refine', 'Small · GPU']]) {
        const run = row[model]; if (!run) continue;
        details.append(node('p', `${name}: ${run.error || `${seconds(run.firstWordMs)} first words · ${seconds(run.releaseMs)} after speech · ${percent(run.score?.wer)} word errors${run.timingValid ? '' : ' · Timing interrupted; rerun'}\n${run.text || '(No speech)'}`}`));
        if (!run.error) details.append(node('p', `At speech end: ${run.textAtRelease || '(No words yet)'}\nProcessing backlog ${seconds(run.backlogEarlyMs)} → ${seconds(run.backlogLateMs)} · ${seconds(run.backlogP95Ms)} at 95th percentile`));
      }
    }
    output.append(details);
  }
  async export(save) {
    try { await save(); }
    catch (error) { if (error.name !== 'AbortError') $('speech-status').textContent = `Could not save: ${error.message}`; }
  }
  dispose() { cancelTimeout(this.renderTimer); document.removeEventListener('visibilitychange', this.onVisibility); if (this.audioUrl) URL.revokeObjectURL(this.audioUrl); this.audio = null; }
}
