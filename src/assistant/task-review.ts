/** A turn is provenance, not a sufficient verification basis. No arbitrary file hashing in the renderer. */
import { canonical } from '../core/model.js';
export interface TaskReviewBasis {
    taskId: string; goalRevision: number; criteriaHash: string;
    sessionId: string; externalThreadId: string; turnId: string;
    artifactHash: string; dependencyFingerprint: string | null;
    coverage: 'complete-for-declared-scope' | 'partial' | 'unknown';
    verifierProfile: string;
}
export function applicableReview(checked: TaskReviewBasis, current: TaskReviewBasis): { applicable:boolean; reason:string } {
    if (checked.coverage !== 'complete-for-declared-scope' || current.coverage !== 'complete-for-declared-scope'
        || checked.dependencyFingerprint === null || current.dependencyFingerprint === null)
        return {applicable:false,reason:'Не подтверждена полнота области проверки'};
    // A new unrelated discussion turn does not change an immutable checked artifact. The selected
    // result retains its source turn; dependencies and goal determine applicability, not chat length.
    const relevant=(b:TaskReviewBasis)=>({taskId:b.taskId,goalRevision:b.goalRevision,criteriaHash:b.criteriaHash,
        artifactHash:b.artifactHash,dependencyFingerprint:b.dependencyFingerprint,coverage:b.coverage,verifierProfile:b.verifierProfile});
    return canonical(relevant(checked))===canonical(relevant(current))
        ?{applicable:true,reason:'Те же проверенные зависимости и цель'}
        :{applicable:false,reason:'Цель, результат или проверочная зависимость изменились'};
}
