/** Reserving an unknown upper price is forbidden. Estimates never release money. */
export interface Reservation {
    id: string;
    upper: number;
    estimate: number | null;
    confirmed: number | null;
}
export declare class Budget {
    readonly limit: number;
    private reservations;
    constructor(limit: number, initial?: Reservation[]);
    get available(): number;
    reserve(id: string, upper: number | null): Reservation;
    estimate(id: string, value: number): void;
    settle(id: string, confirmed: number): void;
    snapshot(): Reservation[];
}
export type EffectState = 'prepared' | 'dispatched' | 'unknown' | 'confirmed' | 'absent';
export interface Effect {
    id: string;
    generation: number;
    state: EffectState;
    idempotencyKey: string | null;
    remoteId: string | null;
}
export declare function mayRetry(effect: Effect, currentGeneration: number, receiverGuaranteesKey: boolean): boolean;
export interface ProgressState {
    noProgress: number;
    evidence: string[];
    closed: string[];
    maxNoProgress: number;
}
export declare function recordCycle(state: ProgressState, evidence: string[], closed: string[]): ProgressState;
export type LeaseState = 'held' | 'revoked' | 'quarantine' | 'released';
export interface Lease {
    id: string;
    resource: string;
    generation: number;
    state: LeaseState;
}
export declare function revoke(lease: Lease): Lease;
export declare function release(lease: Lease, observedOwnerGeneration: number, observedReleased: boolean): Lease;
export interface CommandRecord {
    fingerprint: string;
    result: unknown;
}
export declare class CommandLedger {
    private records;
    private pending;
    constructor(records?: Record<string, CommandRecord>);
    apply<T>(commandId: string, payload: unknown, fn: () => Promise<T>): Promise<T>;
    snapshot(): Record<string, CommandRecord>;
}
export declare class BoundedQueue<T> {
    private maxItems;
    private maxBytes;
    private policy;
    private items;
    private used;
    private next;
    readonly dropped: number[];
    droppedOmitted: number;
    constructor(maxItems: number, maxBytes: number, policy: 'reject' | 'latest');
    push(value: T, size: number): number;
    pop(): {
        value: T;
        sequence: number;
    } | null;
    get byteLength(): number;
    get length(): number;
}
export interface Sample<T> {
    sequence: number;
    at: number;
    value: T;
}
export declare function arrivalSample<A, B>(events: ({
    type: 'value';
    sample: Sample<B>;
} | {
    type: 'trigger';
    sample: Sample<A>;
})[]): [
    A,
    B
][];
/** Finite event-time batch with explicit watermarks, not a claimed live audio engine. */
export declare function eventTimeSample<A, B>(triggers: Sample<A>[], values: Sample<B>[], watermarks: [
    number,
    number
]): [
    A,
    B
][];
