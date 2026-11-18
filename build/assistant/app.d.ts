import { SessionEvent } from './contracts.js';
declare global {
    interface Window {
        DeskLiveEvents: {
            analyzeEnvelopes: (events: SessionEvent[], gap: boolean) => any;
        };
        CodexTelemetry: {
            parseText: (text: string, source: string) => any;
            analyze: (events: any[], warnings: string[]) => any;
        };
    }
}
