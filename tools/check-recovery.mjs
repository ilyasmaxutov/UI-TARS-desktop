/** CLI fault-injection lab, not a Rust host, browser session or Windows acceptance. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createDocument} from '../build/core/graph.js';
import {StartOutbox} from '../build/core/outbox.js';
import {FileIntentRepository, SqlLabReceiver} from '../tests/helpers/recovery-lab.mjs';
const directory=process.argv[2];
if(!directory)throw Error('Usage: node tools/check-recovery.mjs <NEW-output-directory>');
const root=path.resolve(directory);
if(fs.existsSync(root))throw Error('Output directory must not exist; evidence is never overwritten.');
fs.mkdirSync(root,{recursive:true});
const repo=new FileIntentRepository(path.join(root,'outbox'));
let receiver=new SqlLabReceiver(path.join(root,'receiver.sqlite3'));
try {
 const outbox=new StartOutbox(repo,receiver);
 const intent=await outbox.prepare(createDocument('recovery-lab','Проверка потерянного ответа','normalize'),[{path:'control.txt',content:'Реальная строка   \r\n'}]);
 receiver.close();receiver=null;
 const child=spawnSync(process.execPath,[fileURLToPath(new URL('../tests/helpers/crash-dispatch.mjs',import.meta.url)),root,intent.id],{encoding:'utf8',timeout:15000});
 assert.equal(child.status,91,child.stderr);
 const before=await repo.get(intent.id);assert.equal(before.state,'sending');
 receiver=new SqlLabReceiver(path.join(root,'receiver.sqlite3'));
 const restored=new StartOutbox(new FileIntentRepository(path.join(root,'outbox')),receiver);
 const observed=await restored.reconcile(intent.id);assert.equal(observed.state,'review');
 const repeated=await restored.send(intent.id);assert.equal(repeated.id,observed.id);
 const after=await repo.get(intent.id);
 const runs=receiver.db.prepare('SELECT count(*) n FROM runs').get().n;
 assert.equal(runs,1);assert.equal(receiver.deliveries,0);assert.equal(after.state,'confirmed');
 const result={
  release:'0.2.0',scope:'Node CLI contract lab; actual production SQL migration and TypeScript outbox; test-only file repository and receiver',
  fault:'process.exit(91) after receiver SQL COMMIT, before receipt is returned',
  excluded:['Rust host execution','Windows IPC','IndexedDB','OS power loss','untrusted-code isolation'],
  platform:process.platform,node:process.version,sqlite:receiver.db.prepare('SELECT sqlite_version() version').get().version,
  commandId:intent.id,commandFingerprint:intent.fingerprint,runId:observed.id,childExitCode:child.status,
  beforeReconcile:before.state,afterReconcile:after.state,logicalRunCount:runs,dispatchesDuringRecovery:receiver.deliveries,
  sameRunAfterExplicitSameIdSend:repeated.id===observed.id,
  output:observed.artifacts[0].files[0],artifactHash:observed.artifacts[0].hash,
  sqlMigrationSha256:createHash('sha256').update(fs.readFileSync(new URL('../native/crates/core/src/schema/v2.sql',import.meta.url))).digest('hex'),
  passed:true
 };
 fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(result,null,2)+'\n');
 fs.writeFileSync(path.join(root,'child-stderr.txt'),child.stderr);
 console.log(JSON.stringify(result,null,2));
} finally { receiver?.close(); }
