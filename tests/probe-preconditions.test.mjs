import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isUnmaterializedPrecondition, isFreshThreadResumePrecondition } from '../scripts/codex-probe-preconditions.mjs';

// Reduced from the second actual Windows Codex 0.170.0 probe. User paths and
// unrelated metadata are deliberately absent; IDs/errors retain their bytes.
const observed = JSON.parse(readFileSync(new URL('./fixtures/codex-unmaterialized-0.170.json', import.meta.url), 'utf8'));
const { threadId, readThread, turnsResponse, resumeResponse } = observed;
const accepts = (resume = resumeResponse, thread = readThread, prior = turnsResponse) =>
  isFreshThreadResumePrecondition(resume, threadId, thread, prior);

test('probe records actual fresh-thread missing-rollout sequence as an unavailable resume', () => {
  assert.equal(isUnmaterializedPrecondition(turnsResponse, 'thread/turns/list', threadId, readThread), true);
  assert.equal(accepts(), true);
  // This predicate records a precondition, never a successful resume receipt.
  assert.equal(Object.hasOwn(resumeResponse, 'result'), false);
});

test('probe rejects missing rollout for a different thread', () => {
  const different = structuredClone(resumeResponse);
  different.error.message = different.error.message.replace(threadId, 'different-thread');
  assert.equal(accepts(different), false);
});

test('probe requires the earlier exact unmaterialized-list boundary', () => {
  assert.equal(isFreshThreadResumePrecondition(resumeResponse, threadId, readThread, undefined), false);
  assert.equal(accepts(resumeResponse, readThread, {}), false);
  assert.equal(accepts(resumeResponse, readThread, { result: { data: [] } }), false);
  const different = structuredClone(turnsResponse);
  different.error.message = different.error.message.replace(threadId, 'different-thread');
  assert.equal(accepts(resumeResponse, readThread, different), false);
});

test('probe rejects materialized, active, missing, or mismatched thread snapshots', () => {
  for (const snapshot of [
    { ...readThread, turns: [{ id: 'known-turn' }] },
    { ...readThread, status: { type: 'active' } },
    { id: threadId, status: { type: 'idle' } },
    { ...readThread, id: 'different-thread' },
  ]) assert.equal(accepts(resumeResponse, snapshot), false);
});

test('probe does not generalize the missing-rollout code or message', () => {
  assert.equal(accepts({ error: { ...resumeResponse.error, code: -32603 } }), false);
  assert.equal(accepts({ error: { ...resumeResponse.error, message: `${resumeResponse.error.message}; storage failed` } }), false);
  assert.equal(accepts({ error: { code: -32600, message: 'no rollout found' } }), false);
  assert.equal(accepts({ result: { thread: { id: threadId } } }), false);
});
