import { ResearchCheckpoint } from './research.js';
export declare function decodeResearchCheckpoint(text: string): ResearchCheckpoint;
export declare function renderResearchTrace(c: ResearchCheckpoint | null, origin: 'host' | 'import', goalRevision?: number): string;
