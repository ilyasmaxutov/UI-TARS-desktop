import { Document, Kind, Params } from './model.js';
export interface Diagnostic {
    code: string;
    message: string;
    nodeId?: string;
    edgeId?: string;
}
export interface Plan {
    documentId: string;
    revision: number;
    order: string[];
    layers: string[][];
    diagnostics: Diagnostic[];
}
/** Pure preflight; never touches a filesystem, provider or model. */
export declare function compile(doc: Document): Plan;
export declare function defaultParams(kind: Kind): Params;
export declare class Editor {
    document: Document;
    private past;
    private future;
    constructor(document: Document);
    commit(mutator: (d: Document) => void, expected?: number): void;
    undo(): boolean;
    redo(): boolean;
    add(kind: Kind, workspaceId: string, sheetId: string, x?: number, y?: number): string;
    connect(source: string, target: string): void;
    remove(nodeId: string): void;
    reference(nodeId: string, workspaceId: string, sheetId: string): void;
}
/** Validates imported documents before they enter rendering or execution. */
export declare function validateDocument(input: unknown): asserts input is Document;
export type TemplateName = 'report' | 'normalize' | 'empty' | 'agent';
export declare function createDocument(projectId: string, name: string, template?: TemplateName): Document;
