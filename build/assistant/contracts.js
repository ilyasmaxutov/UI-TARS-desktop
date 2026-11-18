/** Codex Direct: independent of the built-in graph Run. No browser-side effect authority. */
import { assert, validateFiles } from '../core/model.js';
export function validateWorkspaceBinding(binding) {
    if (binding.kind === 'inline') {
        validateFiles(binding.files);
        return;
    }
    assert(binding.kind === 'mounted' && /^[A-Za-z0-9_-]{1,128}$/.test(binding.id), 'BINDING', 'Неверная привязка');
    assert(typeof binding.rootPath === 'string' && binding.rootPath.length <= 32760
        && !/[\u0000-\u001f]/.test(binding.rootPath)
        && /^(?:[A-Za-z]:[\\/]|\/|\\\\[^\\]+\\[^\\]+)/.test(binding.rootPath), 'BINDING_PATH', 'Нужен абсолютный путь');
    assert(['read-only', 'workspace-write'].includes(binding.access), 'BINDING_ACCESS', 'Неизвестный профиль');
    // Lexical validation is not an ACL, an OS sandbox, or proof of current directory identity.
}
