import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishRepository } from '../scripts/publish-github.mjs';
function git(cwd, ...args) {
  const r = spawnSync('git', ['-c','user.name=Fixture','-c','user.email=fixture@localhost',...args], {cwd,encoding:'utf8'});
  assert.equal(r.status,0,r.stderr); return r.stdout.trim();
}
function setup() {
  const root=mkdtempSync(join(tmpdir(),'studio-publish-test-')), local=join(root,'source'), remote=join(root,'remote.git');
  mkdirSync(local);git(local,'init','-q','-b','studio/test');writeFileSync(join(local,'code.txt'),'baseline');
  git(local,'add','.');git(local,'commit','-qm','baseline');const baseline=git(local,'rev-parse','HEAD');
  writeFileSync(join(local,'code.txt'),'actual current source');git(local,'commit','-qam','implementation');
  git(root,'init','--bare','-q',remote);
  git(local,'push','-q',remote,`${baseline}:refs/heads/main`);
  const opts={root:local,url:remote,branch:'studio/native-ci',baseline,validateSource:false};
  return {root,local,remote,baseline,opts,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test('publisher sends actual history to one branch; main and source checkout remain untouched',()=>{
 const f=setup();try{const head=git(f.local,'rev-parse','HEAD'),r=publishRepository(f.opts);
 assert.equal(r.status,'published');assert.equal(r.remote,head);assert.equal(git(f.remote,'rev-parse','main'),f.baseline);
 assert.equal(git(f.remote,'show','studio/native-ci:code.txt'),'actual current source');
 assert.equal(git(f.local,'rev-parse','HEAD'),head);assert.equal(git(f.local,'status','--porcelain'),'');
 }finally{f.cleanup();}
});
test('publisher repeated after success performs zero pushes',()=>{const f=setup();try{publishRepository(f.opts);const r=publishRepository(f.opts);assert.equal(r.status,'already-published');assert.equal(r.pushes,0);}finally{f.cleanup();}});
test('publisher rejects uncommitted changes before uploading',()=>{const f=setup();try{writeFileSync(join(f.local,'code.txt'),'unsaved');assert.throws(()=>publishRepository(f.opts),/Uncommitted/);assert.equal(git(f.remote,'branch','--list','studio/native-ci'),'');}finally{f.cleanup();}});
test('publisher rejects unrelated remote work without overwriting it',()=>{const f=setup();try{git(f.local,'push','-q',f.remote,`${f.baseline}:refs/heads/studio/native-ci`);const other=join(f.root,'other');git(f.root,'clone','-q',f.remote,other);git(other,'checkout','-q','studio/native-ci');writeFileSync(join(other,'other.txt'),'owner work');git(other,'add','.');git(other,'commit','-qm','owner');git(other,'push','-q','origin','studio/native-ci');const remote=git(f.remote,'rev-parse','studio/native-ci');assert.throws(()=>publishRepository(f.opts),/unrelated or newer/);assert.equal(git(f.remote,'rev-parse','studio/native-ci'),remote);}finally{f.cleanup();}});
test('publisher preserves reviewed isolated staging ancestry, not legacy main',()=>{
 const f=setup();try{const staging=join(f.root,'staging');mkdirSync(staging);git(staging,'init','-q','-b','studio/native-ci');writeFileSync(join(staging,'README.md'),'reviewed stage');git(staging,'add','.');git(staging,'commit','-qm','stage');const stage=git(staging,'rev-parse','HEAD');git(staging,'push','-q',f.remote,'HEAD:refs/heads/studio/native-ci');
 const opts={...f.opts,stagingBlobs:{'README.md':git(staging,'rev-parse','HEAD:README.md')}};
 const r=publishRepository(opts),parents=git(f.remote,'show','-s','--format=%P',r.remote).split(' ');
 assert.deepEqual(parents,[git(f.local,'rev-parse','HEAD'),stage]);assert.equal(git(f.remote,'show','studio/native-ci:code.txt'),'actual current source');assert.equal(git(f.remote,'rev-parse','main'),f.baseline);
 assert.equal(publishRepository(opts).pushes,0);
 }finally{f.cleanup();}
});
test('publisher refuses a race after inspection; no force overwrite',()=>{
 const f=setup();try{const other=join(f.root,'competitor');git(f.root,'clone','-q',f.local,other);writeFileSync(join(other,'raced.txt'),'race');git(other,'add','.');git(other,'commit','-qm','race');const race=git(other,'rev-parse','HEAD');
 assert.throws(()=>publishRepository({...f.opts,beforePush:()=>git(other,'push','-q',f.remote,'HEAD:refs/heads/studio/native-ci')}),/not confirmed/);
 assert.equal(git(f.remote,'rev-parse','studio/native-ci'),race);
 }finally{f.cleanup();}
});
test('publisher refuses main as destination and wrong source ancestry',()=>{const f=setup();try{assert.throws(()=>publishRepository({...f.opts,branch:'main'}),/Only a studio/);assert.throws(()=>publishRepository({...f.opts,baseline:'0000000000000000000000000000000000000000'}),/baseline/);}finally{f.cleanup();}});
