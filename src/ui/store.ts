import { assert, clone, Project, LIMITS, validateFiles } from '../core/model.js';
import { validateDocument } from '../core/graph.js';
import { Run } from '../core/runtime.js';
export interface SavedState {
    schema: 1;
    revision: number;
    projects: Project[];
    activeProject: string;
    runs: Run[];
    theme: 'dark' | 'light';
}
export function validateState(v: unknown): asserts v is SavedState {
    assert(v && typeof v === 'object', 'STATE', 'Некорректный архив');
    const s = v as SavedState;
    assert(Number.isSafeInteger(s.revision) && s.revision >= 0 && (s.theme === 'dark' || s.theme === 'light'), 'STATE', 'Некорректная редакция или тема');
    assert(s.schema === 1 && Array.isArray(s.projects) && s.projects.length > 0 && s.projects.length <= 32 && typeof s.activeProject === 'string' && Array.isArray(s.runs) && s.runs.length <= LIMITS.runs, 'STATE', 'Некорректная структура');
    for (const p of s.projects) {
        assert(typeof p.id === 'string' && typeof p.title === 'string' && Array.isArray(p.files), 'STATE', 'Некорректный проект');
        validateDocument(p.document);
        assert(p.document.projectId === p.id, 'STATE', 'Документ другого проекта');
        validateFiles(p.files);
    }
    assert(new Set(s.projects.map(p => p.id)).size === s.projects.length && s.projects.some(p => p.id === s.activeProject), 'STATE', 'Неизвестный или повторный ID проекта');
}
export interface NativeBridge {
    invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}
declare global {
    interface Window {
        __TAURI__?: {
            core: NativeBridge;
        };
    }
}
export const native = window.__TAURI__?.core ?? null;
export class Store {
    private db: IDBDatabase | null = null;
    private memory: SavedState | null = null;
    async open(): Promise<void> {
        if (native)
            return;
        this.db = await new Promise((resolve, reject) => { const r = indexedDB.open('platform-studio-v1', 1); r.onupgradeneeded = () => r.result.createObjectStore('state'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    }
    async read(): Promise<SavedState | null> {
        if (native)
            return native.invoke<SavedState | null>('load_state');
        if (!this.db)
            return this.memory;
        return new Promise((resolve, reject) => { const tx = this.db!.transaction('state', 'readonly'); const q = tx.objectStore('state').get('current'); q.onsuccess = () => resolve((q.result as SavedState | undefined) ?? null); q.onerror = () => reject(q.error); });
    }
    async save(state: SavedState, expected: number): Promise<void> {
        validateState(state);
        assert(new TextEncoder().encode(JSON.stringify(state)).byteLength <= 32 * 1024 * 1024, 'STORE_LIMIT', 'Состояние превысило 32 МиБ. Экспортируйте проект.');
        if (native) {
            await native.invoke('save_state', { state, expected });
            return;
        }
        if (!this.db) {
            if (this.memory)
                assert(this.memory.revision === expected, 'CONFLICT', 'Состояние изменено в другом окне');
            this.memory = clone(state);
            return;
        }
        await new Promise<void>((resolve, reject) => {
            const tx = this.db!.transaction('state', 'readwrite');
            const store = tx.objectStore('state');
            const q = store.get('current');
            let conflict = false;
            q.onsuccess = () => { const old = q.result as SavedState | undefined; if (old && old.revision !== expected) {
                conflict = true;
                tx.abort();
                return;
            } store.put(clone(state), 'current'); };
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(new Error(conflict ? 'CONFLICT: состояние изменено в другом окне. Экспортируйте текущую работу и перезагрузите документ.' : 'Не удалось сохранить данные'));
        });
    }
}
