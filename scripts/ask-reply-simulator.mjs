// Full Pageborne UI + real SDK and simulator renderer. Agent and model replies
// are fixtures; this cannot reproduce iOS process memory limits.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import express from 'express';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const out = path.resolve('test-results/ask-reply-simulator'); await mkdir(out, { recursive: true });
const temp = await mkdtemp(path.join(os.tmpdir(), 'pageborne-reply-'));
let command = { id: 0 }, observed = {}, child, vite; const messages = [];
const app = express(); app.use(express.json());
app.get('/test/control', (_req, res) => res.json(command));
app.post('/test/observed', (req, res) => { observed = req.body; res.json({ ok: true }); });
app.get('/api/info', (_req, res) => res.json({ provider: 'codex' }));
app.get('/api/events', (_req, res) => res.type('text/event-stream').send(': connected\n\n'));
app.get('/api/messages', (_req, res) => res.json({ state: 'idle', messages }));
app.get('/api/sessions/:id/history', (_req, res) => res.json({ history: [] }));
app.post('/api/prompt', (req, res) => { messages.push({ id: messages.length + 1, type: 'user_prompt', text: req.body.text }, { id: messages.length + 2, type: 'result', success: true, text: 'Your test message came through.' }); res.json({ sessionId: 'reply-fixture' }); });
const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
const origin = `http://127.0.0.1:${server.address().port}`; process.env.PAGEBORNE_ASK_ORIGINS = origin;
const driver = `<script>
localStorage.setItem('even-reader:preferences:v1', JSON.stringify({ask:{mode:'terminal',endpoint:location.origin,token:'fixture',agent:'codex'},speechRefinement:true}));
const OriginalWorker=Worker;window.__workerCalls=[];
window.Worker=class {
 constructor(url, options){if(!String(url).includes('speech-worker'))return new OriginalWorker(url,options);}
 postMessage(data){window.__workerCalls.push({operation:data.operation,model:data.model});if(data.operation==='cancel')return;
  if(data.operation==='prepare'&&data.model==='refine'){window.__refine={worker:this,id:data.id};queueMicrotask(()=>this.onmessage({data:{id:data.id,progress:'Downloading corrections · 10 / 586 MB'}}));return;}
  queueMicrotask(()=>this.onmessage({data:{id:data.id,result:{backend:data.backend,model:data.model,loadMs:5}}}));}
 terminate(){}
};
let command=0;const errors=[];window.addEventListener('error',e=>errors.push(e.message));window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
async function poll(){try{const c=await(await fetch('/test/control')).json();if(c.id>command){command=c.id;
 if(c.kind==='file'){const t=new DataTransfer();t.items.add(new File(['# Reading\\n\\nA passage to read while waiting for the reply.'],'reading.md',{type:'text/markdown'}));const e=document.querySelector('#file-picker');e.files=t.files;e.dispatchEvent(new Event('change'));}
 if(c.kind==='click')document.querySelector(c.selector).click();
 if(c.kind==='fill'){const e=document.querySelector(c.selector);e.value=c.value;e.dispatchEvent(new Event('input'));}
 if(c.kind==='ready'){const {worker,id}=window.__refine;worker.onmessage({data:{id,result:{backend:'webgpu',model:'Whisper Small English',download:{cacheAvailable:true}}}});}
 }
 await fetch('/test/observed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command,errors,ready:!document.querySelector('#import')?.disabled,documents:document.querySelectorAll('.document-entry').length,ask:document.querySelector('#ask-status')?.textContent,answer:document.querySelector('#ask-answer')?.textContent,models:document.querySelector('#ask-voice-models')?.textContent,turns:document.querySelectorAll('.ask-message-assistant').length,diagnostics:JSON.parse(localStorage.getItem('even-reader:diagnostics:v1')||'null'),calls:window.__workerCalls})});
 }catch(e){errors.push(e.message)}setTimeout(poll,150)}poll();
</script>`;
const result = { passed: false, simulator: '0.9.5', fullApp: true, mockedModels: true, physicalPhone: false };
const api = `http://127.0.0.1:${process.env.SIMULATOR_PORT || 9921}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, label, timeout = 20000) { const end = Date.now()+timeout; while(Date.now()<end){if(observed.errors?.length)throw new Error(JSON.stringify(observed.errors));if(child?.exitCode!=null)throw new Error('Simulator exited');if(check())return;await sleep(100)}throw new Error(`Timed out: ${label}`); }
async function act(value){command={...value,id:command.id+1};await until(()=>observed.command===command.id,value.kind);}
async function input(action){const r=await fetch(`${api}/api/input`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});assert(r.ok);await sleep(350);}
async function shot(name){const r=await fetch(`${api}/api/screenshot/glasses`);assert(r.ok);await writeFile(path.join(out,`${name}.png`),Buffer.from(await r.arrayBuffer()));}
const log = createWriteStream(path.join(out,'simulator.log'));
try {
 vite=await createServer({server:{middlewareMode:true},plugins:[{name:'reply-fixture',transformIndexHtml:html=>html.replace('<head>',`<head>${driver}`)}]});app.use(vite.middlewares);
 const env={...process.env,GSETTINGS_BACKEND:'memory',NO_AT_BRIDGE:'1',GTK_USE_PORTAL:'0',LIBGL_ALWAYS_SOFTWARE:'1',WEBKIT_DISABLE_COMPOSITING_MODE:'1'};
 for(const [key,name]of Object.entries({XDG_RUNTIME_DIR:'runtime',XDG_CONFIG_HOME:'config',XDG_CACHE_HOME:'cache',XDG_DATA_HOME:'data'})){env[key]=path.join(temp,name);await mkdir(env[key],{mode:0o700});}
 child=spawn('dbus-run-session',['--',path.resolve(`node_modules/@evenrealities/sim-${process.platform}-${process.arch}/bin/evenhub-simulator`),origin,'--automation-port',new URL(api).port,'-c',path.join(temp,'config.toml')],{env,detached:true});child.stdout.pipe(log);child.stderr.pipe(log);
 await until(()=>observed.ready,'app startup',45000);await act({kind:'file'});await until(()=>observed.documents===1,'import');
 await act({kind:'click',selector:'[data-document-id="reading.md"] .document-card'});
 await act({kind:'click',selector:'#ask-open'});await until(()=>observed.models?.includes('Downloading corrections'),'cold model');
 for(let i=0;i<5;i++){
  await act({kind:'fill',selector:'#ask-question',value:'This is a test message'});await act({kind:'click',selector:'#ask-send'});
  await until(()=>observed.turns===i+1&&observed.answer==='Your test message came through.'&&observed.diagnostics?.ask?.state==='answer'&&observed.diagnostics?.display?.accepted,'reply');
  await sleep(700);assert.match(observed.models,/Downloading corrections/);assert(!observed.diagnostics.errors.length);
 }
 await shot('01-reply-at-bottom');await input('up');await shot('02-history-scrolled');
 await act({kind:'ready'});await until(()=>observed.models?.includes('GPU corrections: ready'),'late model preparation');await sleep(1000);
 assert(!observed.calls.some(c=>c.operation==='transcribe'&&c.model==='refine'));assert.equal(observed.diagnostics.ask.state,'answer');
 await input('click');await shot('03-back-to-paper');
 Object.assign(result,{passed:true,replies:5,downloadContinuesAcrossReplies:true,latePreparationKeepsReply:true,diagnostics:observed.diagnostics});
} finally {
 await writeFile(path.join(out,'results.json'),JSON.stringify(result,null,2));
 if(child?.pid)try{process.kill(-child.pid,'SIGTERM')}catch{};
 await vite?.close();await new Promise(r=>server.close(r));log.end();await rm(temp,{recursive:true,force:true});
}
console.log(JSON.stringify({passed:result.passed,replies:result.replies,fullApp:true,mockedModels:true}));
