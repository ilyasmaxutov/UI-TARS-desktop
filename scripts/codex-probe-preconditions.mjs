// Metadata-only probe compatibility, not production command reconciliation.
// The complete prior boundary is required: a missing rollout by itself never
// proves that an existing thread is new, empty, or safe to recreate.
export function isUnmaterializedPrecondition(response, method, threadId, thread) {
  return response?.error?.code === -32600
    && response.error.message === `thread ${threadId} is not materialized yet; ${method} is unavailable before first user message`
    && thread?.id === threadId && thread.status?.type === 'idle'
    && Array.isArray(thread.turns) && thread.turns.length === 0;
}

export function isFreshThreadResumePrecondition(response, threadId, thread, turnsResponse) {
  if (!isUnmaterializedPrecondition(turnsResponse, 'thread/turns/list', threadId, thread)) return false;
  return isUnmaterializedPrecondition(response, 'thread/resume', threadId, thread)
    || (response?.error?.code === -32600
      && response.error.message === `no rollout found for thread id ${threadId}`);
}
