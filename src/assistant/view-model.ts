import { ExternalIntent, SessionEvent, SessionRef } from './contracts.js';
/** Rendering policy only. The host repeats all preconditions against its durable state. */
export function actionAvailability(session: SessionRef | null, commands: ExternalIntent[], goalRevision: number) {
    const uncertain = commands.some(c => ['prepared','in_flight','unverified_outcome','unknown_needs_user_decision'].includes(c.state)
        && ['turn/start','turn/steer','thread/start'].includes(c.method));
    return {
        submit: session?.status === 'idle' && !uncertain && goalRevision > 0,
        steer: session?.status === 'running' && !!session.lastKnownTurnId && !uncertain,
        interrupt: session?.status === 'running' && !!session.lastKnownTurnId,
        reconcile: !!session?.externalThreadId,
        uncertain,
        acceptResult: false, // No trusted live snapshot/verifier in this increment.
    };
}
export function mergeEvents(previous: SessionEvent[], incoming: SessionEvent[], sessionId: string): SessionEvent[] {
    const byId = new Map(previous.filter(e => e.sessionId === sessionId).map(e => [e.sequence, e]));
    for (const e of incoming) if (e.sessionId === sessionId && !byId.has(e.sequence)) byId.set(e.sequence, e);
    return [...byId.values()].sort((a,b)=>a.sequence-b.sequence).slice(-8192);
}
export function modelClaims(events: SessionEvent[]): { itemId: string; text: string; turnId: string | null }[] {
    const items = new Map<string,{itemId:string;text:string;turnId:string|null}>();
    for (const e of events) {
        const p = e.frame.params as Record<string,unknown> | undefined;
        if (!p) continue;
        if (e.frame.method === 'item/agentMessage/delta' && typeof p.itemId === 'string' && typeof p.delta === 'string') {
            const old=items.get(p.itemId) ?? {itemId:p.itemId,text:'',turnId:typeof p.turnId==='string'?p.turnId:null};
            old.text=(old.text+p.delta).slice(-200000);items.set(p.itemId,old);
        }
        const item = p.item as Record<string,unknown> | undefined;
        if (e.frame.method === 'item/completed' && item?.type === 'agentMessage' && typeof item.id === 'string' && typeof item.text === 'string')
            items.set(item.id,{itemId:item.id,text:item.text.slice(0,200000),turnId:typeof p.turnId==='string'?p.turnId:null});
    }
    return [...items.values()];
}
