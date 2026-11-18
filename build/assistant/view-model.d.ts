import { ExternalIntent, SessionEvent, SessionRef } from './contracts.js';
/** Rendering policy only. The host repeats all preconditions against its durable state. */
export declare function actionAvailability(session: SessionRef | null, commands: ExternalIntent[], goalRevision: number): {
    submit: boolean;
    steer: boolean;
    interrupt: boolean;
    reconcile: boolean;
    uncertain: boolean;
    acceptResult: boolean;
};
export declare function mergeEvents(previous: SessionEvent[], incoming: SessionEvent[], sessionId: string): SessionEvent[];
export declare function modelClaims(events: SessionEvent[]): {
    itemId: string;
    text: string;
    turnId: string | null;
}[];
