import test from 'node:test';import assert from 'node:assert/strict';
import { ExternalOutbox, markedInput, matchReadback } from '../build/assistant/executor-outbox.js';
import { validateWorkspaceBinding } from '../build/assistant/contracts.js';
import { applicableReview } from '../build/assistant/task-review.js';
import { actionAvailability, mergeEvents, modelClaims } from '../build/assistant/view-model.js';
import { HostExecutionService } from '../build/assistant/service.js';
import { recordCycle } from '../build/core/control.js';
class Repo {
 rows=new Map();failInsert=false;failReplace=false;
 async insert(x){if(this.failInsert)throw Error('disk');assert(!this.rows.has(x.id));this.rows.set(x.id,structuredClone(x));}
 async get(id){return structuredClone(this.rows.get(id)||null);}
 async replace(x,expected){if(this.failReplace)throw Error('disk');assert.equal(this.rows.get(x.id).revision,expected);this.rows.set(x.id,structuredClone(x));}
}
function setup(method='turn/start'){
 const repo=new Repo();let count=0;let snapshot={threadId:'thr',turns:[],complete:true};
 const transport={dispatch:async c=>{count++;assert.equal((await repo.get(c.id)).state,'in_flight');return method==='turn/start'?{turn:{id:'turn'}}:method==='turn/steer'?{turnId:'active'}:method==='thread/start'?{thread:{id:'created'}}:{};},read:async()=>snapshot};
 const box=new ExternalOutbox(repo,transport);const marked=markedInput('command1','Read the existing file');
 const input={id:'command1',taskId:'task',sessionId:'session',goalRevision:1,generation:'g1',method,
 params:{threadId:'thr',input:[{type:'text',text:marked.exactInput}]},expectedThreadId:method==='thread/start'?null:'thr',expectedTurnId:method==='turn/steer'||method==='turn/interrupt'?'active':null,...marked};
 return {repo,transport,box,input,count:()=>count,setSnapshot:s=>snapshot=s};
}
const userTurn=(text,id='turn')=>({id,status:'completed',items:[{type:'userMessage',content:[{type:'text',text}]}]});
test('inline profile keeps NUL rejection',()=>assert.throws(()=>validateWorkspaceBinding({kind:'inline',files:[{path:'x',content:'\0'}]})));
test('mounted repository contains no file snapshot',()=>{const b={kind:'mounted',id:'b',rootPath:'C:\\project',access:'read-only'};validateWorkspaceBinding(b);assert.equal(JSON.stringify(b).includes('files'),false);});
test('mounted metadata does not inherit 256-file cap',()=>validateWorkspaceBinding({kind:'mounted',id:'b',rootPath:'/repo',access:'read-only',gitHead:'a'.repeat(40)}));
test('relative mounted path rejected',()=>assert.throws(()=>validateWorkspaceBinding({kind:'mounted',id:'b',rootPath:'repo',access:'read-only'})));
test('NUL mounted path rejected',()=>assert.throws(()=>validateWorkspaceBinding({kind:'mounted',id:'b',rootPath:'C:\\x\0',access:'read-only'})));
test('unknown access rejected',()=>assert.throws(()=>validateWorkspaceBinding({kind:'mounted',id:'b',rootPath:'/x',access:'anything'})));
test('prepare never touches transport',async()=>{const x=setup();await x.box.prepare(x.input);assert.equal(x.count(),0);});
test('failed insertion never dispatches',async()=>{const x=setup();x.repo.failInsert=true;await assert.rejects(x.box.prepare(x.input));assert.equal(x.count(),0);});
test('persist sending before first possible write',async()=>{const x=setup();await x.box.prepare(x.input);const r=await x.box.send('command1');assert.equal(r.state,'confirmed');assert.equal(r.attempts,1);});
test('send fence persistence failure prevents write',async()=>{const x=setup();await x.box.prepare(x.input);x.repo.failReplace=true;await assert.rejects(x.box.send('command1'));assert.equal(x.count(),0);});
test('confirmed command cannot be resent',async()=>{const x=setup();await x.box.prepare(x.input);await x.box.send('command1');await x.box.send('command1');assert.equal(x.count(),1);});
test('same ID changed body rejected',async()=>{const x=setup();await x.box.prepare(x.input);await assert.rejects(x.box.prepare({...x.input,params:{other:true}}),/ID/);});
test('frozen params tamper rejected before transport',async()=>{const x=setup();await x.box.prepare(x.input);x.repo.rows.get('command1').params.inject='x';await assert.rejects(x.box.send('command1'));assert.equal(x.count(),0);});
test('lost ACK becomes unknown and repeated send is blocked',async()=>{const x=setup();await x.box.prepare(x.input);x.transport.dispatch=async()=>{throw Error('lost ack');};await assert.rejects(x.box.send('command1'));assert.equal((await x.repo.get('command1')).state,'unverified_outcome');await assert.rejects(x.box.send('command1'),/повтор/);});
test('restart in-flight is reconciliation only',async()=>{const x=setup();await x.box.prepare(x.input);const c=x.repo.rows.get('command1');c.state='in_flight';c.attempts=1;c.revision++;const r=await new ExternalOutbox(x.repo,x.transport).reconcile(c.id);assert.equal(r.state,'unknown_needs_user_decision');assert.equal(x.count(),0);});
test('empty complete readback does not prove absence',async()=>{const x=setup();await x.box.prepare(x.input);x.repo.rows.get('command1').state='unverified_outcome';assert.equal((await x.box.reconcile('command1')).state,'unknown_needs_user_decision');});
test('exact nonce + exact user text can reconcile',async()=>{const x=setup();await x.box.prepare(x.input);x.repo.rows.get('command1').state='unverified_outcome';x.setSnapshot({threadId:'thr',turns:[userTurn(x.input.exactInput)],complete:false});assert.equal((await x.box.reconcile('command1')).remoteId,'turn');assert.equal(x.count(),0);});
test('unknown can later become confirmed',async()=>{const x=setup();await x.box.prepare(x.input);x.repo.rows.get('command1').state='unverified_outcome';await x.box.reconcile('command1');x.setSnapshot({threadId:'thr',turns:[userTurn(x.input.exactInput)],complete:true});assert.equal((await x.box.reconcile('command1')).state,'confirmed');});
test('assistant echo never proves delivery',()=>{const x=setup();const t=userTurn(x.input.exactInput);t.items[0].type='agentMessage';assert.equal(matchReadback(x.input,{threadId:'thr',turns:[t],complete:true}),null);});
test('same text in a different thread rejected',()=>{const x=setup();assert.equal(matchReadback(x.input,{threadId:'other',turns:[userTurn(x.input.exactInput)],complete:true}),null);});
test('nonce without exact input rejected',()=>{const x=setup();assert.equal(matchReadback(x.input,{threadId:'thr',turns:[userTurn(x.input.marker)],complete:true}),null);});
test('multiple exact matches remain ambiguous',()=>{const x=setup();assert.equal(matchReadback(x.input,{threadId:'thr',turns:[userTurn(x.input.exactInput,'a'),userTurn(x.input.exactInput,'b')],complete:true}),null);});
test('steer readback must be in expected turn',()=>{const x=setup('turn/steer');assert.equal(matchReadback(x.input,{threadId:'thr',turns:[userTurn(x.input.exactInput,'other')],complete:true}),null);});
test('steer refuses mismatched ACK',async()=>{const x=setup('turn/steer');await x.box.prepare(x.input);x.transport.dispatch=async()=>({turnId:'wrong'});await assert.rejects(x.box.send('command1'));});
test('interrupt ACK does not prove stopped',async()=>{const x=setup('turn/interrupt');await x.box.prepare(x.input);const r=await x.box.send('command1');assert.equal(r.state,'confirmed');assert.equal(r.stopped,undefined);});
test('interrupt reconciles only observed interrupted target',()=>{const x=setup('turn/interrupt');assert.equal(matchReadback(x.input,{threadId:'thr',turns:[{id:'active',status:'completed',items:[]}],complete:true}),null);assert.equal(matchReadback(x.input,{threadId:'thr',turns:[{id:'active',status:'interrupted',items:[]}],complete:true}),'active');});
test('competing outbox instances issue at most one write',async()=>{const x=setup();await x.box.prepare(x.input);const b=new ExternalOutbox(x.repo,x.transport);await Promise.allSettled([x.box.send('command1'),b.send('command1')]);assert.equal(x.count(),1);});
const basis={taskId:'t',goalRevision:1,criteriaHash:'c',sessionId:'s',externalThreadId:'th',turnId:'turn',artifactHash:'a',dependencyFingerprint:'dep',coverage:'complete-for-declared-scope',verifierProfile:'test-profile'};
test('review is scoped to goal and real dependencies',()=>assert.equal(applicableReview(basis,basis).applicable,true));
for(const k of ['taskId','criteriaHash','artifactHash','dependencyFingerprint','verifierProfile'])test('review invalidated by '+k,()=>assert.equal(applicableReview(basis,{...basis,[k]:'changed'}).applicable,false));
test('review invalidated by goal revision',()=>assert.equal(applicableReview(basis,{...basis,goalRevision:2}).applicable,false));
test('unknown workspace fingerprint cannot pass',()=>assert.equal(applicableReview({...basis,dependencyFingerprint:null},basis).applicable,false));
test('partial scan cannot pass',()=>assert.equal(applicableReview(basis,{...basis,coverage:'partial'}).applicable,false));
test('unrelated chat turn does not invalidate a sealed result',()=>assert.equal(applicableReview(basis,{...basis,turnId:'unrelated'}).applicable,true));
test('host RPC rejects arbitrary methods before invocation',async()=>{let n=0;const s=new HostExecutionService(async()=>{n++;});await assert.rejects(s.call('execute_shell',{command:'x'}));assert.equal(n,0);});
test('host RPC forwards named operation only',async()=>{let args;const s=new HostExecutionService(async(...x)=>{args=x;return {};});await s.call('codex_events',{afterSequence:7});assert.deepEqual(args,['assistant_rpc',{operation:'codex_events',params:{afterSequence:7}}]);});
const session={id:'s',taskId:'t',profileKind:'codex-direct',externalThreadId:'th',lastKnownTurnId:'turn',generation:'g',status:'running'};
test('working task can be interrupted but cannot start another turn',()=>{const a=actionAvailability(session,[],1);assert(a.interrupt);assert(a.steer);assert(!a.submit);});
test('unknown send disables steer without disabling cancellation',()=>{const a=actionAvailability(session,[{method:'turn/start',state:'unverified_outcome'}],1);assert(!a.steer);assert(a.interrupt);});
test('no live acceptance from a model message',()=>assert(!actionAvailability({...session,status:'idle'},[],1).acceptResult));
test('events from another session are excluded',()=>assert.deepEqual(mergeEvents([],[{sequence:1,sessionId:'other'}],'s'),[]));
test('replayed event sequence deduplicated',()=>assert.equal(mergeEvents([{sequence:1,sessionId:'s'}],[{sequence:1,sessionId:'s'}],'s').length,1));
test('final assistant item replaces streamed text, not double-appended',()=>{const frames=[{frame:{method:'item/agentMessage/delta',params:{itemId:'a',turnId:'t',delta:'ha'}}},{frame:{method:'item/completed',params:{turnId:'t',item:{id:'a',type:'agentMessage',text:'halo'}}}}];assert.equal(modelClaims(frames)[0].text,'halo');});
test('tool completion alone is not fresh evidence',()=>{let p={noProgress:0,maxNoProgress:3,evidence:[],closed:[]};for(let n=0;n<3;n++)p=recordCycle(p,[],[]);assert.equal(p.noProgress,3);assert.throws(()=>recordCycle(p,[],[]));});
