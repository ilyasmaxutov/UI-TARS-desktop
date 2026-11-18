import type { AcceptanceReceipt } from './review.js';
import { Document, FileData, Goal, Obligation } from './model.js';
export type Value = {
    type: 'text';
    text: string;
} | {
    type: 'files';
    files: FileData[];
};
export interface Finding {
    obligationId: string;
    description: string;
    passed: boolean;
    detail: string;
}
export interface ManifestEntry {
    path: string;
    hash: string;
    bytes: number;
}
export interface Artifact {
    id: string;
    files: FileData[];
    manifest: ManifestEntry[];
    hash: string;
    goalRevision: number;
    graphRevision: number;
    findings: Finding[];
}
export interface RunEvent {
    seq: number;
    runId: string;
    at: string;
    kind: string;
    nodeId: string | null;
    message: string;
}
export type NodeState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface Run {
    id: string;
    documentId: string;
    revision: number;
    goalRevision: number;
    state: 'running' | 'review' | 'failed' | 'cancelled' | 'interrupted';
    startedAt: string;
    finishedAt: string | null;
    nodes: Record<string, NodeState>;
    previews: Record<string, string>;
    events: RunEvent[];
    artifacts: Artifact[];
    error: string | null;
    profile: 'browser-local' | 'native-builtins';
    inputHash: string;
    documentHash: string;
    inputs: FileData[];
    goal: Goal;
    accepted: boolean;
    cancelRequested?: boolean;
    commandFingerprint?: string | null;
    acceptance?: AcceptanceReceipt | null;
}
export interface Change {
    path: string;
    status: 'added' | 'modified' | 'unchanged' | 'removed';
    before: string | null;
    after: string | null;
}
export interface RunHooks {
    signal?: AbortSignal;
    onUpdate?: (run: Run) => void;
    checkpoint?: () => Promise<void>;
    concurrency?: number;
    profile?: Run['profile'];
}
export declare function verify(files: readonly FileData[], checks: readonly Obligation[]): Finding[];
export declare function seal(files: readonly FileData[], doc: Document, findings: Finding[]): Promise<Artifact>;
export declare function validateArtifact(artifact: Artifact): Promise<boolean>;
export declare function diff(base: readonly FileData[], next: readonly FileData[]): Change[];
export declare function publicationConflicts(base: readonly FileData[], current: readonly FileData[], next: readonly FileData[]): string[];
/** Executes only compiled, built-in pure operations; never evals code or starts a process. */
export declare function execute(document: Document, sourceFiles: FileData[], hooks?: RunHooks): Promise<Run>;
