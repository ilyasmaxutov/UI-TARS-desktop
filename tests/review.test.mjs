import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, Editor } from '../build/core/graph.js';
import { canonical, sha256 } from '../build/core/model.js';
import { execute, seal, validateArtifact } from '../build/core/runtime.js';
import { inspectResult, acceptResult, acceptedResultValid, resultBinding, mergeProjection } from '../build/core/review.js';
const source = [{path:'note.txt',content:'Строка  \r\n'}];
async function fixture() { const doc=createDocument('p','review','normalize'); return {doc,run:await execute(doc,source)}; }
function code(name) { return error=>error.code===name; }
test('inspection recomputes bytes and criteria, acceptance binds exact snapshot',async()=>{
 const {run}=await fixture(), inspection=await inspectResult(run); assert.equal(inspection.scope,'builtin-criteria');
 assert.equal(run.accepted,false);const accepted=await acceptResult(run,inspection.bindingHash);
 assert.equal(accepted.accepted,true);assert.equal(run.accepted,false);assert.equal(await acceptedResultValid(accepted),true);
 assert.deepEqual(await acceptResult(accepted,inspection.bindingHash),accepted);
});
test('inspection rejects wrong artifact ID even with an unchanged hash',async()=>{
 const {run}=await fixture();run.artifacts[0].id='forged';assert.equal(await validateArtifact(run.artifacts[0]),false);
 await assert.rejects(inspectResult(run),code('ARTIFACT'));
});
test('valid self-consistent artifact of another graph revision is not acceptable',async()=>{
 const {doc,run}=await fixture();doc.revision++;run.artifacts[0]=await seal(run.artifacts[0].files,doc,[]);
 assert.equal(await validateArtifact(run.artifacts[0]),true);await assert.rejects(inspectResult(run),code('ARTIFACT_BINDING'));
});
test('a convincing success finding cannot hide failed frozen criteria',async()=>{
 const {doc,run}=await fixture();run.artifacts[0]=await seal(source,doc,[{passed:true,description:'all done',obligationId:'fake',detail:'all tests pass'}]);
 await assert.rejects(inspectResult(run),code('VERIFICATION'));
});
test('review checks every result, not only first artifact',async()=>{
 const {doc,run}=await fixture();run.artifacts.push(await seal(source,doc,[]));await assert.rejects(inspectResult(run),code('VERIFICATION'));
});
test('actual two-output graph is fully inspected and accepted',async()=>{
 const doc=createDocument('p','two outputs','normalize');const e=new Editor(doc),w=doc.workspaces[0],s=w.sheets[0];
 const text=e.add('source.text',w.id,s.id),file=e.add('text.to_file',w.id,s.id),check=e.add('verify.files',w.id,s.id),result=e.add('result.files',w.id,s.id);
 e.commit(d=>{d.nodes.find(n=>n.id===file).params.path='second.md';d.goal.obligations=[{id:'nonempty',kind:'nonempty',path:'*',value:'',description:'nonempty'}];});
 e.connect(text,file);e.connect(file,check);e.connect(check,result);const run=await execute(e.document,source);
 const inspection=await inspectResult(run);assert.equal(inspection.findings.length,2);assert.equal((await acceptResult(run,inspection.bindingHash)).acceptance.artifactHashes.length,2);
});
test('empty self-consistent output is rejected',async()=>{
 const {doc,run}=await fixture();run.artifacts=[await seal([],doc,[])];await assert.rejects(inspectResult(run),code('EMPTY'));
});
test('cancellation is an acceptance fence even before worker termination',async()=>{
 const {run}=await fixture();run.cancelRequested=true;await assert.rejects(inspectResult(run),code('CANCELLED'));
});
test('late completion with queued node does not pass inspection',async()=>{
 const {run}=await fixture();run.nodes[Object.keys(run.nodes)[0]]='queued';await assert.rejects(inspectResult(run),code('INCOMPLETE'));
});
test('changed frozen inputs fail inspection, not just artifact inspection',async()=>{
 const {run}=await fixture();run.inputs[0].content='changed';await assert.rejects(inspectResult(run),code('INPUT_BINDING'));
});
test('stale owner decision rejected after goal content change without revision bump',async()=>{
 const {run}=await fixture();const binding=(await inspectResult(run)).bindingHash;run.goal.original='another goal';
 await assert.rejects(acceptResult(run,binding),code('STALE_RESULT'));
});
test('acceptance receipt cannot be copied from a different run',async()=>{
 const {run}=await fixture();let accepted=await acceptResult(run,(await inspectResult(run)).bindingHash);
 accepted.id='run_other';assert.equal(await acceptedResultValid(accepted),false);
});
test('bare accepted boolean from version 0.1 is not a new acceptance receipt',async()=>{
 const {run}=await fixture();run.accepted=true;assert.equal(await acceptedResultValid(run),false);
});
test('owner acceptance survives stale running and pre-acceptance replies',async()=>{
 const {run}=await fixture();const accepted=await acceptResult(run,(await inspectResult(run)).bindingHash);
 assert.deepEqual(mergeProjection(accepted,{...run,state:'running'}),accepted);
 assert.deepEqual(mergeProjection(accepted,run),accepted);
});
test('terminal result and task envelope cannot be replaced',async()=>{
 const {run}=await fixture();const changed=structuredClone(run);changed.artifacts[0].files[0].content='late write';
 assert.throws(()=>mergeProjection(run,changed),code('TERMINAL_IMMUTABLE'));
 const other=structuredClone(run);other.goal.original='reinterpreted';assert.throws(()=>mergeProjection(run,other),code('RUN_BINDING'));
});
test('projection detects rewritten event and ignores older checkpoint',async()=>{
 const {run}=await fixture();const old={...structuredClone(run),state:'running',events:run.events.slice(0,-2),artifacts:[]};
 const newer={...structuredClone(old),events:run.events.slice(0,-1)};
 assert.deepEqual(mergeProjection(newer,old),newer);
 const bad=structuredClone(newer);bad.events[0].message='rewrite';assert.throws(()=>mergeProjection(old,bad),code('EVENT_REWRITE'));
});
test('review binding uses canonical data, not self-reported finding descriptions',async()=>{
 const {run}=await fixture();const a=await resultBinding(run);run.artifacts[0].findings[0].description='marketing success';
 assert.equal(await resultBinding(run),a);assert.match(a,/^[0-9a-f]{64}$/);
});

test('unknown criterion cannot be accepted after JSON import',async()=>{
 const {run}=await fixture();run.goal.obligations[0].kind='success_always';await assert.rejects(inspectResult(run),code('CRITERION'));
});
test('accepted receipt is not silently rewritten by later projections',async()=>{
 const {run}=await fixture();const accepted=await acceptResult(run,await resultBinding(run));const bad=structuredClone(accepted);bad.acceptance.at='rewritten';
 assert.throws(()=>mergeProjection(accepted,bad),code('ACCEPTANCE_REWRITE'));
});
test('projection preserves exact original command fingerprint',async()=>{
 const {run}=await fixture();run.commandFingerprint='a'.repeat(64);const other=structuredClone(run);other.commandFingerprint='b'.repeat(64);
 assert.throws(()=>mergeProjection(run,other),code('RUN_BINDING'));
});
test('checked-in cross-language binding fixture matches TypeScript contract',async()=>{
 const {readFileSync}=await import('node:fs');const f=JSON.parse(readFileSync(new URL('../fixtures/review-binding.json',import.meta.url),'utf8'));
 assert.equal(await resultBinding(f.run),f.bindingHash);assert.equal((await inspectResult(f.run)).bindingHash,f.bindingHash);
 assert.equal(await sha256(f.specJson),f.run.commandFingerprint);assert.equal(f.specJson,canonical({document:f.document,files:f.files}));
});
test('acceptance cannot reuse a malformed receipt with an otherwise matching hash',async()=>{
 const {run}=await fixture();const accepted=await acceptResult(run,await resultBinding(run));accepted.acceptance.actor='worker';
 await assert.rejects(acceptResult(accepted,await resultBinding(accepted)),code('ACCEPTANCE'));
});
