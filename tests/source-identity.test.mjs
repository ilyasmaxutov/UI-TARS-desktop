import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const guard = resolve('scripts/verify-source.mjs');

test('source identity guard accepts the real Platform Studio tree', () => {
  const r = spawnSync(process.execPath, [guard], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('source identity guard rejects the old UI-TARS tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'studio-guard-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({name:'ui-tars',version:'0.5.0'}));
    const r = spawnSync(process.execPath, [guard], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /incomplete/);
  } finally { rmSync(root, {recursive:true, force:true}); }
});

test('source identity guard rejects a fake project with only matching paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'studio-guard-'));
  try {
    const paths = ['docs/REQUIREMENTS.json','src/core/model.ts','native/Cargo.toml','native/crates/host/src/lib.rs','native/tools/economy/go.mod','native/tools/economy/research.go','assistant/src/live-events.js'];
    for (const p of paths) { const full = join(root,p); mkdirSync(resolve(full,'..'),{recursive:true}); writeFileSync(full,''); }
    writeFileSync(join(root,'package.json'), JSON.stringify({name:'other-project',version:'0.5.0'}));
    const r = spawnSync(process.execPath, [guard], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Unexpected project identity/);
  } finally { rmSync(root, {recursive:true, force:true}); }
});
