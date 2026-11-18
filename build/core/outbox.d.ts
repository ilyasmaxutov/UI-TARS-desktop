/** Persisted start intent. Transport loss never means that execution did not start. */
import { Document, FileData } from './model.js';
import { Run } from './runtime.js';
export interface StartIntent {
    schema: 1;
    id: string;
    revision: number;
    projectId: string;
    createdAt: string;
    state: 'prepared' | 'sending' | 'unknown' | 'confirmed';
    document: Document;
    files: FileData[];
    fingerprint: string;
    attempts: number;
    runId: string | null;
    lastError: string | null;
}
export interface IntentRepository {
    insert(intent: StartIntent): Promise<void>;
    get(id: string): Promise<StartIntent | null>;
    list(): Promise<StartIntent[]>;
    replace(intent: StartIntent, expectedRevision: number): Promise<void>;
}
export interface StartTransport {
    capabilities(): Promise<{
        protocol: number;
        durableCommands: boolean;
    }>;
    start(commandId: string, document: Document, files: FileData[]): Promise<Run>;
    lookup(commandId: string): Promise<Run | null>;
}
export declare function pendingIntent(intent: StartIntent): boolean;
export declare function validateIntent(intent: StartIntent): Promise<void>;
export declare class StartOutbox {
    private repository;
    private transport;
    private inflight;
    constructor(repository: IntentRepository, transport: StartTransport);
    prepare(document: Document, files: FileData[]): Promise<StartIntent>;
    private single;
    private read;
    private set;
    private receipt;
    reconcile(id: string): Promise<Run | null>;
    send(id: string): Promise<Run | null>;
}
