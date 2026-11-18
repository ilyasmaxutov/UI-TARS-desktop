import { ExternalIntent } from './contracts.js';
export interface ExternalRepository {
    insert(intent: ExternalIntent): Promise<void>;
    get(id: string): Promise<ExternalIntent | null>;
    replace(intent: ExternalIntent, expectedRevision: number): Promise<void>;
}
export interface Readback {
    threadId: string;
    turns: {
        id: string;
        status: string;
        items: {
            type: string;
            content?: {
                type: string;
                text?: string;
            }[];
        }[];
    }[];
    complete: boolean;
}
export interface ExternalTransport {
    dispatch(intent: ExternalIntent): Promise<Record<string, unknown>>;
    read(intent: ExternalIntent): Promise<Readback>;
}
export declare function intentFingerprint(x: ExternalIntent): Promise<string>;
export declare function markedInput(commandId: string, text: string): {
    marker: string;
    exactInput: string;
};
export declare function matchReadback(intent: ExternalIntent, readback: Readback): string | null;
export declare function confirmedRemoteId(intent: ExternalIntent, response: Record<string, unknown>): string | null;
export declare class ExternalOutbox {
    private repository;
    private transport;
    constructor(repository: ExternalRepository, transport: ExternalTransport);
    prepare(input: Omit<ExternalIntent, 'fingerprint' | 'state' | 'revision' | 'attempts' | 'remoteId' | 'reason'>): Promise<ExternalIntent>;
    private read;
    private update;
    send(id: string): Promise<ExternalIntent>;
    reconcile(id: string): Promise<ExternalIntent>;
}
