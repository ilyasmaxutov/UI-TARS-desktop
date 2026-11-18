import { Project } from '../core/model.js';
import { Run } from '../core/runtime.js';
export interface SavedState {
    schema: 1;
    revision: number;
    projects: Project[];
    activeProject: string;
    runs: Run[];
    theme: 'dark' | 'light';
}
export declare function validateState(v: unknown): asserts v is SavedState;
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
export declare const native: NativeBridge | null;
export declare class Store {
    private db;
    private memory;
    open(): Promise<void>;
    read(): Promise<SavedState | null>;
    save(state: SavedState, expected: number): Promise<void>;
}
