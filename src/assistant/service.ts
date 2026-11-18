/** Fixed allowlist mirror of desktop IPC. The renderer never starts a process or chooses a shell command. */
import { assert } from '../core/model.js';
export type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
const operations = new Set(['research_checkpoint','research_sweep','research_reconcile','tasks_list','task_create','task_read','task_revise','task_sessions','codex_continuation','codex_configure','codex_open','codex_submit','codex_steer','codex_interrupt','codex_reconcile','codex_disconnect','codex_session','codex_commands','codex_command','codex_events','codex_abandon_prepared']);
export class HostExecutionService {
    constructor(private invoke: Invoke) {}
    async call<T = unknown>(operation: string, params: Record<string, unknown> = {}): Promise<T> {
        assert(operations.has(operation), 'METHOD', 'Недопустимая операция');
        return await this.invoke('assistant_rpc', { operation, params }) as T;
    }
    async capabilities(): Promise<Record<string, unknown>> { return await this.invoke('capabilities') as Record<string, unknown>; }
    async chooseWorkspace(): Promise<unknown> { return this.invoke('choose_workspace'); }
    async chooseCodex(): Promise<string | null> { return await this.invoke('choose_codex') as string | null; }
}
