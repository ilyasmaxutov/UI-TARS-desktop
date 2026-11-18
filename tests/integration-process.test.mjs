import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {ExternalOutbox,markedInput} from '../build/assistant/executor-outbox.js';
import {FixturePeer} from '../tools/integration-lab/peer-transport.mjs';import {SqlRepository} from '../tools/integration-lab/sql-repository.mjs';
function input(){const marked=markedInput('command_crash','Synthetic request: привет');return{id:'command_crash',taskId:'task',sessionId:'session',goalRevision:1,generation:'g',method:'turn/start',params:{threadId:'fixture-thread',input:[{type:'text',text:marked.exactInput}]},expectedThreadId:'fixture-thread',expectedTurnId:null,...marked};}
async function read(peer){const r=await peer.call('thread/read',{threadId:'fixture-thread'});const t=await peer.call('thread/turns/list',{threadId:'fixture-thread',itemsView:'full'});return {threadId:r.thread.id,turns:t.data,complete:t.nextCursor===null};}
test('real child crash after recorded acceptance; reopened SQLite reconciles without second send',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-codex-protocol-'));let repo=new SqlRepository(path.join(root,'local.db'));let peer=new FixturePeer(root,'after-accept-before-ack');
 try{
  await peer.initialize();let dispatches=0;let outbox=new ExternalOutbox(repo,{dispatch:async c=>{dispatches++;return peer.call(c.method,c.params);},read:()=>read(peer)});
  await outbox.prepare(input());await assert.rejects(outbox.send('command_crash'),/91/);assert.equal((await repo.get('command_crash')).state,'unverified_outcome');assert.equal(dispatches,1);repo.close();
  repo=new SqlRepository(path.join(root,'local.db'));peer=new FixturePeer(root);await peer.initialize();let recoverySends=0;
  outbox=new ExternalOutbox(repo,{dispatch:async()=>{recoverySends++;throw Error('must not send');},read:()=>read(peer)});
  const recovered=await outbox.reconcile('command_crash');assert.equal(recovered.state,'confirmed');assert.equal(recovered.remoteId,'fixture-turn-1');assert.equal(recoverySends,0);assert.equal(JSON.parse(fs.readFileSync(path.join(root,'remote.json'))).mutations,1);
  assert.equal((await outbox.send('command_crash')).state,'confirmed');assert.equal(recoverySends,0);
 }finally{repo.close();await peer.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('notifications can precede start acknowledgement',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-codex-order-'));const p=new FixturePeer(root);
 try{await p.initialize();const r=await p.call('turn/start',input().params);assert.equal(r.turn.id,'fixture-turn-1');assert.deepEqual(p.events.map(x=>x.method),['turn/started','turn/completed']);}finally{await p.close();fs.rmSync(root,{recursive:true,force:true});}
});
