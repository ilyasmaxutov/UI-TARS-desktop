/** Codex Direct: independent of the built-in graph Run. No browser-side effect authority. */
import { WorkspaceBinding, assert, validateFiles } from '../core/model.js';
import { ProgressState } from '../core/control.js';
export function validateWorkspaceBinding(binding: WorkspaceBinding): void {
    if (binding.kind === 'inline') { validateFiles(binding.files); return; }
    assert(binding.kind === 'mounted' && /^[A-Za-z0-9_-]{1,128}$/.test(binding.id), 'BINDING', 'Неверная привязка');
    assert(typeof binding.rootPath === 'string' && binding.rootPath.length <= 32760
        && !/[\u0000-\u001f]/.test(binding.rootPath)
        && /^(?:[A-Za-z]:[\\/]|\/|\\\\[^\\]+\\[^\\]+)/.test(binding.rootPath), 'BINDING_PATH', 'Нужен абсолютный путь');
    assert(['read-only', 'workspace-write'].includes(binding.access), 'BINDING_ACCESS', 'Неизвестный профиль');
    // Lexical validation is not an ACL, an OS sandbox, or proof of current directory identity.
}
export interface Task {
    id: string; projectId: string; title: string; goalRevision: number; original: string;
    binding: WorkspaceBinding; progress: ProgressState;
}
export type CommandState = 'prepared' | 'in_flight' | 'confirmed' | 'unverified_outcome' | 'unknown_needs_user_decision' | 'rejected';
export type Method = 'thread/start' | 'thread/resume' | 'turn/start' | 'turn/steer' | 'turn/interrupt';
export interface ExternalIntent {
    id: string; taskId: string; sessionId: string; goalRevision: number; generation: string;
    method: Method; params: Record<string, unknown>; fingerprint: string;
    expectedThreadId: string | null; expectedTurnId: string | null;
    marker: string | null; exactInput: string | null;
    state: CommandState; revision: number; attempts: number;
    remoteId: string | null; reason: string | null;
}
export interface SessionRef {
    id: string; taskId: string; externalThreadId: string | null; lastKnownTurnId: string | null;
    profileKind: 'codex-direct'; generation: string; status: string;
}
export interface SessionEvent {
    sequence: number; sessionId: string; generation: string; at: string;
    origin: 'codex' | 'host' | 'synthetic-peer'; frame: Record<string, unknown>;
    truncated: boolean;
}
export interface ExecutionService {
    capabilities(): Promise<Record<string, unknown>>;
    openOrCreateTaskSession(task: Task, commandId: string, externalThreadId?: string): Promise<SessionRef>;
    submitTurn(sessionId: string, commandId: string, goalRevision: number, text: string): Promise<ExternalIntent>;
    steerTurn(sessionId: string, commandId: string, goalRevision: number, expectedTurnId: string, text: string): Promise<ExternalIntent>;
    interruptTurn(sessionId: string, commandId: string, expectedTurnId: string): Promise<ExternalIntent>;
    reconcileSession(sessionId: string): Promise<SessionRef>;
    events(sessionId: string, afterSequence: number): Promise<{ events: SessionEvent[]; nextSequence: number; gap: boolean }>;
}
