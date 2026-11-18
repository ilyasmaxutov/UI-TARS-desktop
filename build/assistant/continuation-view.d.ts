import type { ExternalIntent, SessionRef } from './contracts.js';
/** Read-only projection of the native capsule. The renderer never assembles
 * model context or treats an imported report as authoritative task memory. */
export interface ContinuationPreview {
    schema: 1;
    taskId: string;
    goalRevision: number;
    text: string;
    utf8Bytes: number;
    maxUtf8Bytes: number;
    sha256: string;
    unresolvedCommands: number;
    activeSessions: number;
    uncertainSessions?: number;
    research: {
        present: boolean;
        investigationId?: string;
        sequence?: number;
        freshness?: string;
        sourceFreshness?: string;
        status?: string;
    };
    omissions: {
        reports: number;
        evidenceRefs: number;
        hypotheses: number;
        findings: number;
        observations?: number;
        gaps?: number;
        excerpts?: number;
        rawOutputs: boolean;
    };
}
export declare function continuationAvailability(preview: ContinuationPreview | null, session: SessionRef | null, commands: ExternalIntent[], configured: boolean, pending: boolean): {
    allowed: boolean;
    reason: string;
};
export declare function renderContinuationPreview(preview: ContinuationPreview | null, error: string): string;
