import { IntentRepository, StartIntent } from '../core/outbox.js';
/** Local durable outbox separate from editable UI state; no in-memory fallback. */
export declare class IndexedIntentRepository implements IntentRepository {
    private db;
    open(): Promise<void>;
    private transaction;
    get(id: string): Promise<StartIntent | null>;
    list(): Promise<StartIntent[]>;
    insert(intent: StartIntent): Promise<void>;
    replace(intent: StartIntent, expectedRevision: number): Promise<void>;
}
