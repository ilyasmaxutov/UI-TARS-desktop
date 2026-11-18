/** CLI fault experiment with the production TS outbox and actual v3 SQL.
 * The JSON-RPC peer is explicitly synthetic; no Codex/model/network call is made. */
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {ExternalOutbox,markedInput} from '../build/assistant/executor-outbox.js';
import {FixturePeer} from './integration-lab/peer-transport.mjs';import {SqlRepository} from './integration-lab/sql-repository.mjs';
const output=path.resolve(process.argv[2]||'verification/integration-0.3/crash-evidence');
if(fs.existsSync(output))throw Error('Output exists. Choose a new directory; evidence is not overwritten.');
fs.mkdirSync(output,{recursive:true});
let repo=new SqlRepository(path.join(output,'local.sqlite3')),peer=new FixturePeer(output,'after-accept-before-ack');
let sends=0,recoverySends=0;const trace=[];
const read=async()=>{trace.push('thread/read');const r=await peer.call('thread/read',{threadId:'fixture-thread'});trace.push('thread/turns/list');const p=await peer.call('thread/turns/list',{threadId:'fixture-thread',itemsView:'full'});return{threadId:r.thread.id,turns:p.data,complete:p.nextCursor===null};};
try {
 await peer.initialize();let box=new ExternalOutbox(repo,{dispatch:async c=>{sends++;return peer.call(c.method,c.params);},read});
 const marked=markedInput('crash_evidence','Synthetic integration request — не пользовательские данные');
 await box.prepare({id:'crash_evidence',taskId:'task',sessionId:'session',goalRevision:1,generation:'g',method:'turn/start',params:{threadId:'fixture-thread',input:[{type:'text',text:marked.exactInput}]},expectedThreadId:'fixture-thread',expectedTurnId:null,...marked});
 let failure='';try{await box.send('crash_evidence');}catch(e){failure=String(e);}
 const afterFailure=await repo.get('crash_evidence');repo.close();
 repo=new SqlRepository(path.join(output,'local.sqlite3'));peer=new FixturePeer(output);await peer.initialize();
 box=new ExternalOutbox(repo,{dispatch:async()=>{recoverySends++;throw Error('Forbidden resend');},read});
 const recovered=await box.reconcile('crash_evidence');await box.send('crash_evidence');
 const remote=JSON.parse(fs.readFileSync(path.join(output,'remote.json'),'utf8'));
 const passed=sends===1&&recoverySends===0&&remote.mutations===1&&recovered.state==='confirmed'&&recovered.remoteId==='fixture-turn-1';
 const report={passed,fixture:true,liveCodex:false,rustTransport:false,windows:false,sqlite:repo.db.prepare('SELECT sqlite_version() version').get().version,node:process.version,failure,afterFailure,recovered,sends,recoverySends,remoteMutations:remote.mutations,readbackMethods:trace,limits:'Test-only JS repository/peer adapter; real child termination after fsync; no power-loss or Windows claim.'};
 fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2),{flag:'wx'});
 console.log(JSON.stringify({passed,sends,recoverySends,remoteMutations:remote.mutations,state:recovered.state,output},null,2));if(!passed)process.exitCode=1;
} finally {repo.close();await peer.close();}
const checksums={};for(const name of fs.readdirSync(output).sort()){const f=path.join(output,name);if(fs.statSync(f).isFile())checksums[name]=crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');}fs.writeFileSync(path.join(output,'SHA256.json'),JSON.stringify(checksums,null,2),{flag:'wx'});
