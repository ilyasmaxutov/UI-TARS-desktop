import { Finding, Run } from './runtime.js';
export interface Inspection {
    runId: string;
    bindingHash: string;
    artifactHashes: string[];
    findings: {
        artifactHash: string;
        checks: Finding[];
    }[];
    inspectedAt: string;
    scope: 'builtin-criteria';
}
export interface AcceptanceReceipt {
    schema: 1;
    runId: string;
    bindingHash: string;
    artifactHashes: string[];
    at: string;
    actor: 'owner';
    scope: 'builtin-criteria';
}
/** No timestamp, display label or self-reported finding is an authority. */
export declare function resultBinding(run: Run): Promise<string>;
export declare function inspectResult(run: Run): Promise<Inspection>;
export declare function acceptResult(run: Run, expectedBinding: string): Promise<Run>;
export declare function acceptedResultValid(run: Run): Promise<boolean>;
/** Reject stale replies without mutating the newer cached projection. */
export declare function mergeProjection(previous: Run | null, incoming: Run): Run;
