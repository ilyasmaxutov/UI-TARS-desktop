export interface TaskReviewBasis {
    taskId: string;
    goalRevision: number;
    criteriaHash: string;
    sessionId: string;
    externalThreadId: string;
    turnId: string;
    artifactHash: string;
    dependencyFingerprint: string | null;
    coverage: 'complete-for-declared-scope' | 'partial' | 'unknown';
    verifierProfile: string;
}
export declare function applicableReview(checked: TaskReviewBasis, current: TaskReviewBasis): {
    applicable: boolean;
    reason: string;
};
