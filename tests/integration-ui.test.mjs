/* Real bundled assistant code in a DOM stub. No browser, layout or Windows is exercised. */
import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import fs from 'node:fs';import crypto from 'node:crypto';
const html=fs.readFileSync(new URL('../dist/assistant.html',import.meta.url),'utf8');
const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
const task={id:'task_1',projectId:'p',title:'Моя работа',goalRevision:1,original:'Сохранить исходную цель',binding:{kind:'mounted',id:'b',rootPath:'C:\\repo',access:'read-only'},progress:{}};
const session={id:'s',taskId:'task_1',externalThreadId:'thread',lastKnownTurnId:null,profileKind:'codex-direct',generation:'g',status:'idle'};
async function harness(native=false,options={}){
 const nodes=new Map(),listeners=new Map(),saved=new Map(),calls=[];let interval;
 function element(id){if(!nodes.has(id)){const e={id,value:'',checked:false,tagName:'DIV',disabled:false,_html:'',listeners:{},dataset:{},addEventListener(k,f){this.listeners[k]=f;},click(){}};
 Object.defineProperty(e,'innerHTML',{get(){return this._html},set(text){this._html=text;for(const m of text.matchAll(/<textarea[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)){const n=element(m[1]);n.tagName='TEXTAREA';n.value=m[2];}for(const m of text.matchAll(/<input[^>]*id="([^"]+)"[^>]*>/g)){const n=element(m[1]);n.tagName='INPUT';n.value=m[0].match(/value="([^"]*)"/)?.[1]||'';n.checked=false;}}});nodes.set(id,e);}return nodes.get(id);}
 const document={getElementById:element,activeElement:null,addEventListener:(k,f)=>listeners.set(k,f),querySelector:s=>nodes.get(s.slice(1))||null};
 const invoke=async(command,args)=>{calls.push([command,structuredClone(args)]);if(command==='capabilities')return {codexDirect:{protocol:1}};if(command==='choose_codex')return 'C:\\Codex\\codex.exe';if(command==='choose_workspace')return task.binding;
 const op=args?.operation;if(options.handler){const r=await options.handler(op,args?.params);if(r!==undefined)return r;}
 if(op==='codex_continuation')return {schema:1,taskId:task.id,goalRevision:1,text:'{}',utf8Bytes:2,maxUtf8Bytes:12288,sha256:'a'.repeat(64),unresolvedCommands:0,activeSessions:0,research:{present:false},omissions:{reports:0,evidenceRefs:0,hypotheses:0,findings:0,rawOutputs:true}};if(op==='tasks_list')return [task];if(op==='task_sessions')return [session];if(op==='codex_events')return {events:[],nextSequence:0,gap:false};if(op==='codex_session')return session;if(op==='codex_commands')return [];if(op==='codex_configure')return {configured:true};if(op==='codex_submit')return {id:args.params.commandId,state:'confirmed',method:'turn/start',sessionId:'s'};throw Error('unexpected operation '+command+':'+op);};
 const ctx={console,document,localStorage:{getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v)},crypto:crypto.webcrypto,TextEncoder,TextDecoder,Uint8Array,Blob,URL,JSON,Date,Intl,Math,structuredClone,setInterval:f=>{interval=f;return 1;},setTimeout,clearTimeout};
 ctx.window=ctx;ctx.globalThis=ctx;if(native)ctx.__TAURI__={core:{invoke}};vm.createContext(ctx);for(const s of scripts)vm.runInContext(s,ctx);
 const settle=async()=>{for(let i=0;i<25;i++)await new Promise(r=>setImmediate(r));};await settle();
 return {nodes,calls,saved,document,html:()=>element('app').innerHTML,element,settle,poll:async()=>{await interval?.();await settle();},input(id,value){const e=element(id);e.value=value;listeners.get('input')({target:e});},async click(dataset){const b={dataset,disabled:false};const target={closest(sel){return(sel==='[data-action]'&&dataset.action||sel==='[data-screen]'&&dataset.screen||sel==='[data-task]'&&dataset.task)?b:null;}};listeners.get('click')({target});await settle();}};
}
test('standalone live screen explicitly lacks a host and has no scenario reducer',async()=>{const h=await harness();assert.match(h.html(),/без нативного хоста/);assert.equal(h.calls.length,0);assert(!scripts.at(-1).includes('load-scenario'));});
test('boot is read-only: no provider process or model request',async()=>{const h=await harness(true);assert.match(h.html(),/Моя работа/);assert(h.calls.every(c=>c[0]==='capabilities'||['tasks_list','task_sessions','codex_events','codex_session','codex_commands','codex_continuation'].includes(c[1]?.operation)));});
test('prompt draft survives screen navigation and is escaped',async()=>{const h=await harness(true);h.input('draft','<script>user text</script>');await h.click({screen:'history'});await h.click({screen:'work'});assert.match(h.html(),/&lt;script&gt;user text/);assert(!h.html().includes('<script>user text'));});
test('consent is read before rendering busy state removes the checkbox',async()=>{const h=await harness(true);await h.click({screen:'connections'});h.input('codex-path','C:\\Codex\\codex.exe');h.element('consent').checked=true;await h.click({action:'configure'});const c=h.calls.find(c=>c[1]?.operation==='codex_configure');assert.equal(c?.[1].params.acknowledgeDirectProfile,true);assert.match(h.html(),/Настройка принята/);});
test('configuration without consent never reaches the host',async()=>{const h=await harness(true);await h.click({screen:'connections'});h.input('codex-path','C:\\Codex\\codex.exe');await h.click({action:'configure'});assert(!h.calls.some(c=>c[1]?.operation==='codex_configure'));});
test('submitting writes a local command before calling the transport',async()=>{let h;let observed=false;h=await harness(true,{handler(op){if(op==='codex_submit'){observed=[...h.saved.values()].some(t=>JSON.parse(t).pending?.operation==='codex_submit');}}});h.input('draft','Actual request');await h.click({action:'send'});assert(observed);assert(h.calls.some(c=>c[1]?.operation==='codex_submit'));});
test('lost host response keeps exact pending command; it is not resent by polling',async()=>{const h=await harness(true,{handler(op){if(op==='codex_submit')throw Error('lost ACK');}});h.input('draft','One request');await h.click({action:'send'});await h.poll();assert.equal(h.calls.filter(c=>c[1]?.operation==='codex_submit').length,1);assert([...h.saved.values()].some(x=>JSON.parse(x).pending));assert.match(h.html(),/локально сохранённая команда/);});
test('polling does not replace a focused editor',async()=>{const h=await harness(true);h.document.activeElement=h.element('draft');h.element('app')._html+='FOCUS_SENTINEL';await h.poll();assert.match(h.html(),/FOCUS_SENTINEL/);});
test('observe and history are real projections and do not contain demo measurements',async()=>{const h=await harness(true);await h.click({screen:'observe'});assert.match(h.html(),/Наблюдаемые события/);assert(!h.html().includes('8 800'));await h.click({screen:'history'});assert.match(h.html(),/нет кнопки повтора неизвестного эффекта/);});

async function configure(h){await h.click({screen:'connections'});h.input('codex-path','C:\\Codex\\codex.exe');h.element('consent').checked=true;await h.click({action:'configure'});await h.click({screen:'work'});}
test('new context keeps the task, draft and old session without submitting a model turn',async()=>{
 let all=[{...session}],current=all[0],h;
 h=await harness(true,{handler(op,p){
  if(op==='task_sessions')return all;
  if(op==='codex_session')return all.find(s=>s.id===p.sessionId);
  if(op==='codex_disconnect'){current={...current,status:'disconnected'};all[0]=current;return current;}
  if(op==='codex_open'){
   assert.equal(p.taskId,task.id);assert.notEqual(p.sessionId,session.id);assert.equal(p.externalThreadId,null);
   assert([...h.saved.values()].some(s=>JSON.parse(s).pending?.commandId===p.commandId));
   current={...session,id:p.sessionId,externalThreadId:'new-thread'};all.push(current);
   return {session:current,command:{id:p.commandId,state:'confirmed',method:'thread/start',sessionId:p.sessionId}};
  }
  if(op==='codex_reconcile')return {session:current,commands:[],notice:'Reconciled'};
 }});
 await configure(h);h.input('draft','Моё уточнение не потерять');await h.click({action:'new-session'});
 assert.equal(h.calls.filter(c=>c[1]?.operation==='codex_open').length,1);
 assert(!h.calls.some(c=>['codex_submit','codex_steer','task_create'].includes(c[1]?.operation)));
 assert.match(h.html(),/Новая сессия подключена/);assert.match(h.html(),/Моё уточнение не потерять/);assert.match(h.html(),/Сессии этой задачи/);
 h.element('session-select').value=session.id;await h.click({action:'select-session'});
 assert.equal(JSON.parse([...h.saved.values()][0]).selectedSession,session.id);
 assert.equal(h.calls.filter(c=>c[1]?.operation==='codex_open').length,1,'viewing an old session never reopens it automatically');
});
test('a blocker appearing after preview prevents disconnect and new context',async()=>{
 let blocked=false;
 const h=await harness(true,{handler(op){if(op==='codex_continuation')return {schema:1,taskId:task.id,goalRevision:1,text:'{}',utf8Bytes:2,maxUtf8Bytes:12288,sha256:'a'.repeat(64),unresolvedCommands:blocked?1:0,activeSessions:0,research:{present:false},omissions:{reports:0,evidenceRefs:0,hypotheses:0,findings:0,rawOutputs:true}};}});
 await configure(h);blocked=true;await h.click({action:'new-session'});
 assert(!h.calls.some(c=>['codex_open','codex_disconnect'].includes(c[1]?.operation)));
 assert.match(h.html(),/неизвестным исходом/);
});
test('a failed new-context response keeps one pending command and polling cannot resend it',async()=>{
 let all=[{...session}],savedCommand;
 const h=await harness(true,{handler(op,p){
  if(op==='task_sessions')return all;
  if(op==='codex_session')return all.find(s=>s.id===p.sessionId);
  if(op==='codex_disconnect'){all[0]={...session,status:'disconnected'};return all[0];}
  if(op==='codex_open'){
   all.push({...session,id:p.sessionId,externalThreadId:'created-before-lost-ack'});
   savedCommand={id:p.commandId,sessionId:p.sessionId,taskId:p.taskId,method:'thread/start',state:'confirmed'};
   throw Error('lost open ACK');
  }
  if(op==='codex_command')return savedCommand;
 }});
 await configure(h);await h.click({action:'new-session'});await h.poll();await h.poll();
 assert.equal(h.calls.filter(c=>c[1]?.operation==='codex_open').length,1);
 assert([...h.saved.values()].some(s=>JSON.parse(s).pending?.operation==='codex_open'));
 await h.click({action:'recover-local'});
 const local=JSON.parse([...h.saved.values()][0]);assert.equal(local.pending,null);assert.equal(local.selectedSession,savedCommand.sessionId);
 assert.equal(h.calls.filter(c=>c[1]?.operation==='codex_session').at(-1)[1].params.sessionId,savedCommand.sessionId);
 assert.equal(h.calls.filter(c=>c[1]?.operation==='codex_open').length,1);
});
test('unchanged polling does not keep rebuilding the research capsule',async()=>{
 const h=await harness(true);const before=h.calls.filter(c=>c[1]?.operation==='codex_continuation').length;
 await h.poll();await h.poll();assert.equal(h.calls.filter(c=>c[1]?.operation==='codex_continuation').length,before);
});
