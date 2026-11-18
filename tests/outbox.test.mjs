import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import {fileURLToPath} from 'node:url';import{canonical,sha256}from'../build/core/model.js';import path from 'node:path';import os from 'node:os';import {spawnSync}from'node:child_process';
import {createDocument}from'../build/core/graph.js';import{execute}from'../build/core/runtime.js';
import{StartOutbox,validateIntent}from'../build/core/outbox.js';
import{FileIntentRepository,SqlLabReceiver}from'./helpers/recovery-lab.mjs';
const source=[{path:'x.txt',content:'hello  \r\n'}];
class MemoryRepo{
 map=new Map();failInsert=false;failReplace=false;
 async insert(i){if(this.failInsert)throw Error('DISK_FULL');if(this.map.has(i.id))throw Error('ID');this.map.set(i.id,structuredClone(i));}
 async get(id){return structuredClone(this.map.get(id)??null);}
 async list(){return structuredClone([...this.map.values()]);}
 async replace(i,expected){if(this.failReplace)throw Error('DISK_FULL');const old=this.map.get(i.id);if(!old||old.revision!==expected)throw Error('CAS');this.map.set(i.id,structuredClone(i));}
}
class Receiver{
 records=new Map();calls=0;lost=false;failBefore=false;protocol=2;
 async capabilities(){return{protocol:this.protocol,durableCommands:true};}
 async lookup(id){return structuredClone(this.records.get(id)??null);}
 async start(id,document,files){this.calls++;if(this.failBefore)throw Error('TRANSPORT');if(!this.records.has(id)){const run=await execute(document,files,{profile:'native-builtins'});run.commandFingerprint=await sha256(canonical({document,files}));this.records.set(id,run);}if(this.lost)throw Error('RECEIPT_LOST');return this.lookup(id);}
}
async function fixture(){const repo=new MemoryRepo(),receiver=new Receiver(),outbox=new StartOutbox(repo,receiver),doc=createDocument('p','outbox','normalize');return{repo,receiver,outbox,doc};}
test('command is frozen and durably prepared before any transport call',async()=>{const{repo,receiver,outbox,doc}=await fixture();const intent=await outbox.prepare(doc,source);doc.goal.original='changed';assert.equal(receiver.calls,0);assert.notEqual((await repo.get(intent.id)).document.goal.original,doc.goal.original);await validateIntent(await repo.get(intent.id));});
test('cannot send if durable prepare fails',async()=>{const{repo,receiver,outbox,doc}=await fixture();repo.failInsert=true;await assert.rejects(outbox.prepare(doc,source),/DISK_FULL/);assert.equal(receiver.calls,0);});
test('cannot dispatch before sending marker commit',async()=>{const{repo,receiver,outbox,doc}=await fixture();const intent=await outbox.prepare(doc,source);repo.failReplace=true;await assert.rejects(outbox.send(intent.id));assert.equal(receiver.calls,0);});
test('lost acknowledgement recovers one run after client object is recreated',async()=>{const{repo,receiver,outbox,doc}=await fixture();const intent=await outbox.prepare(doc,source);receiver.lost=true;await assert.rejects(outbox.send(intent.id),/RECEIPT_LOST/);assert.equal((await repo.get(intent.id)).state,'unknown');const resumed=new StartOutbox(repo,receiver);const r=await resumed.reconcile(intent.id);assert.equal(r.state,'review');assert.equal(receiver.calls,1);assert.equal((await repo.get(intent.id)).runId,r.id);});
test('reconciliation is read-only when nothing was accepted',async()=>{const{repo,receiver,outbox,doc}=await fixture();const intent=await outbox.prepare(doc,source);receiver.failBefore=true;await assert.rejects(outbox.send(intent.id));assert.equal(await outbox.reconcile(intent.id),null);assert.equal(receiver.calls,1);assert.equal((await repo.get(intent.id)).state,'unknown');});
test('explicit retry uses SAME command ID and frozen payload',async()=>{const{repo,receiver,outbox,doc}=await fixture();const intent=await outbox.prepare(doc,source);receiver.failBefore=true;await assert.rejects(outbox.send(intent.id));receiver.failBefore=false;const r=await outbox.send(intent.id);assert.equal(receiver.records.size,1);assert.ok(receiver.records.has(intent.id));assert.equal((await repo.get(intent.id)).attempts,2);assert.equal(r.inputs[0].content,source[0].content);});
test('simultaneous sends within one client coalesce rather than duplicate',async()=>{const{receiver,outbox,doc}=await fixture();const intent=await outbox.prepare(doc,source);const[a,b]=await Promise.all([outbox.send(intent.id),outbox.send(intent.id)]);assert.equal(a.id,b.id);assert.equal(receiver.calls,1);});
test('tampered queued payload is rejected before transport',async()=>{const{repo,receiver,outbox,doc}=await fixture();const intent=await outbox.prepare(doc,source);repo.map.get(intent.id).files[0].content='other';await assert.rejects(outbox.send(intent.id),e=>e.code==='INTENT_CHANGED');assert.equal(receiver.calls,0);});
test('old host protocol cannot silently weaken delivery guarantees',async()=>{const{receiver,outbox,doc}=await fixture();const intent=await outbox.prepare(doc,source);receiver.protocol=1;await assert.rejects(outbox.send(intent.id),e=>e.code==='PROTOCOL');assert.equal(receiver.calls,0);});
test('wrong run receipt remains unknown instead of attaching another task',async()=>{const{repo,receiver,outbox,doc}=await fixture();const intent=await outbox.prepare(doc,source);receiver.lookup=async()=>{const run=await execute(doc,source,{profile:'native-builtins'});run.commandFingerprint='a'.repeat(64);return run;};await assert.rejects(outbox.send(intent.id),e=>e.code==='RECEIPT_BINDING');assert.notEqual((await repo.get(intent.id)).state,'confirmed');});
test('confirmed command missing from a replaced host database is never replayed',async()=>{const{receiver,outbox,doc}=await fixture();const intent=await outbox.prepare(doc,source);await outbox.send(intent.id);receiver.records.clear();await assert.rejects(outbox.send(intent.id),e=>e.code==='HOST_HISTORY_LOST');assert.equal(receiver.calls,1);});
test('new intentional owner request gets new ID even for identical inputs',async()=>{const{outbox,doc}=await fixture();const a=await outbox.prepare(doc,source),b=await outbox.prepare(doc,source);assert.notEqual(a.id,b.id);assert.equal(a.fingerprint,b.fingerprint);});
test('actual child process exits after SQL commit; disk outbox recovers without second dispatch',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-crash-'));let receiver;
 try{
  const repo=new FileIntentRepository(path.join(root,'outbox'));receiver=new SqlLabReceiver(path.join(root,'receiver.sqlite3'));
  const outbox=new StartOutbox(repo,receiver),intent=await outbox.prepare(createDocument('p','crash','normalize'),source);receiver.close();receiver=null;
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./helpers/crash-dispatch.mjs',import.meta.url)),root,intent.id],{encoding:'utf8',timeout:15000});
  assert.equal(result.status,91,result.stderr);assert.equal((await repo.get(intent.id)).state,'sending');
  receiver=new SqlLabReceiver(path.join(root,'receiver.sqlite3'));const restored=new StartOutbox(new FileIntentRepository(path.join(root,'outbox')),receiver);
  const run=await restored.reconcile(intent.id);assert.equal(run.state,'review');assert.equal(receiver.deliveries,0);
  assert.equal(receiver.db.prepare('SELECT count(*) n FROM runs').get().n,1);assert.equal((await repo.get(intent.id)).state,'confirmed');
  const again=await restored.send(intent.id);assert.equal(again.id,run.id);assert.equal(receiver.deliveries,0);
 }finally{receiver?.close();fs.rmSync(root,{recursive:true,force:true});}
});
