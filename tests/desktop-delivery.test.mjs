import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,cpSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';
import {verifyDesktopInputs} from '../scripts/verify-desktop-inputs.mjs';
import {verifyDelivery} from '../scripts/verify-delivery.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
test('native default opens real assistant and version matches; all web surfaces exist',()=>{const r=verifyDesktopInputs(process.cwd());assert.equal(r.entrypoint,'assistant.html');assert.equal(r.frontendFiles,4);assert.equal(r.guiExecuted,false);});
function fakeDelivery(){const p=mkdtempSync(join(tmpdir(),'studio-pe-fixture-'));const bytes=Buffer.alloc(256);bytes.write('MZ');bytes.writeUInt32LE(128,0x3c);bytes.write('PE\0\0',128,'latin1');bytes.writeUInt16LE(0x8664,132);const files=['studio-desktop.exe','studio-host.exe','studio-economy.exe'].map(name=>{writeFileSync(join(p,name),bytes);return{name,bytes:bytes.length,sha256:hash(bytes)};});const m={schema:1,target:'windows-x64',frontend:'assistant.html',files,claims:{compiled:false,fixture:true}};writeFileSync(join(p,'DELIVERY.json'),JSON.stringify(m));return{p,m,bytes,done:()=>rmSync(p,{force:true,recursive:true})};}
test('package checker validates all three byte identities, not executable behavior',()=>{const f=fakeDelivery();try{const r=verifyDelivery(f.p);assert.equal(r.verifiedFiles,3);assert.equal(r.executed,false);assert.equal(r.claims.compiled,false);}finally{f.done();}});
test('package without local economy helper fails instead of shipping broken desktop',()=>{const f=fakeDelivery();try{rmSync(join(f.p,'studio-economy.exe'));assert.throws(()=>verifyDelivery(f.p),/ENOENT/);}finally{f.done();}});
test('package rejects wrong bytes in host',()=>{const f=fakeDelivery();try{const b=Buffer.from(f.bytes);b[200]=1;writeFileSync(join(f.p,'studio-host.exe'),b);assert.throws(()=>verifyDelivery(f.p),/Hash mismatch/);}finally{f.done();}});
test('package rejects non-Windows executable even with matching hash',()=>{const f=fakeDelivery();try{const b=Buffer.alloc(256,1);writeFileSync(join(f.p,'studio-host.exe'),b);f.m.files[1].sha256=hash(b);writeFileSync(join(f.p,'DELIVERY.json'),JSON.stringify(f.m));assert.throws(()=>verifyDelivery(f.p),/Not an x64 PE/);}finally{f.done();}});
test('package rejects duplicate manifest entry instead of counting it twice',()=>{const f=fakeDelivery();try{f.m.files[2]=f.m.files[1];writeFileSync(join(f.p,'DELIVERY.json'),JSON.stringify(f.m));assert.throws(()=>verifyDelivery(f.p),/Duplicate/);}finally{f.done();}});
test('native script builds helper and both native executables, with delivery readback',()=>{const s=readFileSync('scripts/Build-Windows.ps1','utf8');assert.match(s,/'studio-host','-p','studio-desktop'/);assert.match(s,/economy\\Build-Economy.ps1/);assert.match(s,/verify-delivery.mjs/);assert(s.indexOf("'DELIVERY.json'")>s.indexOf('Build-Economy.ps1'));});
test('Windows workflow invokes full application build, publishes bundle and always preserves logs',()=>{const w=readFileSync('.github/workflows/check.yml','utf8');assert.match(w,/Build-Windows.ps1 -ResolveDependencies/);assert.match(w,/path: release\/PlatformStudio\//);assert.match(w,/native-build-evidence[\s\S]*native\/Cargo.lock/);assert.match(w,/if: always\(\)/);assert.doesNotMatch(w,/pull_request_target|contents: write|secrets\./);});

test('native self-test is explicit, local and does not start Codex or the IPC server',()=>{
 const main=readFileSync('native/crates/host/src/main.rs','utf8'),code=readFileSync('native/crates/host/src/selftest.rs','utf8'),script=readFileSync('scripts/Build-Windows.ps1','utf8');
 assert(main.indexOf('--selftest')<main.indexOf('windows::serve'));
 assert.doesNotMatch(code,/Peer::spawn|Command::new|windows::serve|data_root\(/);
 assert.match(code,/recover_executor_sessions/);assert.match(code,/unverified_outcome/);
 assert.match(script,/studio-host.exe'\) @\('--selftest'\)/);
 assert.match(script,/studio-economy.exe'\) @\('selftest'\)/);
});
