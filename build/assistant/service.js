/** Fixed allowlist mirror of desktop IPC. The renderer never starts a process or chooses a shell command. */
import { assert } from '../core/model.js';
const operations = new Set(['research_checkpoint', 'research_sweep', 'research_reconcile', 'tasks_list', 'task_create', 'task_read', 'task_revise', 'task_sessions', 'codex_continuation', 'codex_configure', 'codex_open', 'codex_submit', 'codex_steer', 'codex_interrupt', 'codex_reconcile', 'codex_disconnect', 'codex_session', 'codex_commands', 'codex_command', 'codex_events', 'codex_abandon_prepared']);
export class HostExecutionService {
    invoke;
    constructor(invoke) {
        this.invoke = invoke;
    }
    async call(operation, params = {}) {
        assert(operations.has(operation), 'METHOD', 'Недопустимая операция');
        return await this.invoke('assistant_rpc', { operation, params });
    }
    async capabilities() { return await this.invoke('capabilities'); }
    async chooseWorkspace() { return this.invoke('choose_workspace'); }
    async chooseCodex() { return await this.invoke('choose_codex'); }
}
