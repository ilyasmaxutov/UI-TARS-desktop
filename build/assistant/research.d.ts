import { ProgressState } from '../core/control.js';
import type { Task } from './contracts.js';
export type Coverage = 'complete' | 'partial' | 'unknown';
export interface ResearchBudget {
    maxSweeps: number;
    wallSeconds: number;
    outputUtf8Bytes: number;
    maxNoProgress: number;
}
export interface Hypothesis {
    id: string;
    claim: string;
    predicts: string[];
    counterEvidence?: string[];
    state: 'open' | 'supported' | 'weakened' | 'refuted' | 'unresolved';
}
export interface ProbeOperation {
    id: string;
    op: string;
    path?: string;
    paths?: string[];
    query?: string;
    startLine?: number;
    lines?: number;
    offset?: number;
    length?: number;
    dependsOn?: string[];
    from?: string;
    limit?: number;
    before?: number;
    after?: number;
    includeGenerated?: boolean;
    artifact?: string;
    stream?: string;
    check?: string;
}
export interface Probe {
    id: string;
    question: string;
    discriminates: string[];
    operations: ProbeOperation[];
    effect: 'read-only' | 'external' | 'mutation';
    priority: number;
    expectedInformation: string;
    acceptance: string;
}
export interface ResearchPlan {
    schema: 1;
    investigationId: string;
    taskId: string;
    goalRevision: number;
    originalGoal: string;
    planVersion: number;
    question: string;
    scope: string[];
    stopRules: string[];
    budget: ResearchBudget;
    hypotheses: Hypothesis[];
    probes: Probe[];
}
export interface SweepRequest {
    sweepId: string;
    plan: ResearchPlan;
    sourceSnapshot: {
        rootHash: string;
        pins: {
            path: string;
            sha256: string;
        }[];
    };
    limits: {
        outputUtf8Bytes: number;
        wallSeconds: number;
    };
    permissionScope: {
        paths: string[];
        effect: 'read-only';
        allowGit: boolean;
    };
}
export interface EvidenceRef {
    id: string;
    probeId: string;
    operationId: string;
    kind: 'file-span' | 'log-span' | 'test-run' | 'external-source' | 'observation';
    locator: string;
    sha256: string;
    observedAt: string;
    coverage: Coverage;
    sourceHash: string;
    noveltyKey: string;
    negative: boolean;
}
export interface SweepReport {
    schema: 1;
    sweepId: string;
    investigationId: string;
    taskId: string;
    goalRevision: number;
    planVersion: number;
    state: 'observed' | 'partial';
    sourceHash: string;
    sourceCoverage: Coverage;
    probes: {
        probeId: string;
        question?: string;
        state: string;
        coverage: Coverage;
        evidenceIds: string[];
        summary: string;
    }[];
    evidenceRefs: EvidenceRef[];
    excerpts: {
        evidenceId: string;
        text: string;
        truncated: boolean;
    }[];
    summary: string;
    gaps: string[];
    unknownEffects: string[];
    untestedHypotheses: string[];
    nextSuggestedQuestions: string[];
    nextAction: string;
    reportArtifact: string;
    reportSha256: string;
    durationMs: number;
    utf8Bytes: number;
    limitUtf8Bytes: number;
    truncated: boolean;
    replayed: boolean;
    resumed: boolean;
    localModelCalls: 0;
    observedTokens: number | null;
}
export interface Finding {
    id: string;
    assertion: string;
    evidenceIds: string[];
    counterEvidenceIds: string[];
    kind: 'observed' | 'inferred' | 'hypothesis';
    scope: string;
    limitations: string[];
    nextCheck?: string;
    author: 'user' | 'agent';
}
export interface ResearchCheckpoint {
    schema: 1;
    sequence: number;
    plan: ResearchPlan;
    reports: SweepReport[];
    findings: Finding[];
    nextAction: string;
    status: 'planning' | 'probing' | 'evaluating' | 'blocked' | 'review';
}
export declare function safeResearchPath(p: unknown): p is string;
export declare function validateResearchRequest(r: SweepRequest, task?: Pick<Task, 'id' | 'goalRevision' | 'original'>): void;
/** An explicit intent classification, not a semantic NLP diagnosis. */
export declare function researchRoute(kind: 'read-range' | 'known-search' | 'diagnose' | 'compare-implementations' | 'unknown-behaviour'): 'direct' | 'investigation';
export declare function validateSweepReport(r: SweepReport, p: ResearchPlan): void;
export declare function startResearch(plan: ResearchPlan): ResearchCheckpoint;
export declare function canSweep(checkpoint: ResearchCheckpoint, progress: ProgressState): boolean;
/** Shared task progress is supplied by TaskStore; creating a new session or
 * investigation does not reset it. Observed positive bytes may be useful even with partial coverage; negative evidence requires complete coverage.
 * The caller must authenticate report provenance; importing JSON is not proof.
 */
export declare function applySweep(checkpoint: ResearchCheckpoint, progress: ProgressState, report: SweepReport): {
    checkpoint: ResearchCheckpoint;
    progress: ProgressState;
};
export declare function addFinding(checkpoint: ResearchCheckpoint, f: Finding): ResearchCheckpoint;
export declare function researchFreshness(c: ResearchCheckpoint, t: Pick<Task, 'id' | 'original' | 'goalRevision'>): 'current' | 'stale-goal';
export declare function continuationCard(c: ResearchCheckpoint, maxBytes?: number): string;
