/** Shared, JSON-only contracts. Views do not own execution; a run freezes a revision. */
export type PortType = 'text' | 'files';
export type Kind = 'source.text' | 'source.files' | 'text.replace' | 'text.stats' | 'files.filter' | 'files.replace' | 'files.normalize' | 'files.report' | 'text.to_file' | 'files.merge' | 'verify.files' | 'result.files' | 'agent.codex' | 'note';
export type Params = Record<string, string | number | boolean>;
export interface NodeDef {
    id: string;
    kind: Kind;
    title: string;
    params: Params;
}
export interface Edge {
    id: string;
    source: string;
    target: string;
    sourcePort: 'out';
    targetPort: 'in';
}
export interface NodeView {
    id: string;
    nodeId: string;
    x: number;
    y: number;
}
export interface Sheet {
    id: string;
    title: string;
    views: NodeView[];
    viewport: {
        x: number;
        y: number;
        zoom: number;
    };
}
export type CheckKind = 'file_exists' | 'contains' | 'not_contains' | 'valid_json' | 'normalized' | 'nonempty';
export interface Obligation {
    id: string;
    description: string;
    kind: CheckKind;
    path: string;
    value: string;
}
export interface Goal {
    original: string;
    revision: number;
    obligations: Obligation[];
}
export interface Workspace {
    id: string;
    title: string;
    sheets: Sheet[];
}
export interface Document {
    schema: 1;
    id: string;
    projectId: string;
    title: string;
    revision: number;
    goal: Goal;
    nodes: NodeDef[];
    edges: Edge[];
    workspaces: Workspace[];
}
export interface FileData {
    path: string;
    content: string;
}
export interface Project {
    id: string;
    title: string;
    document: Document;
    files: FileData[];
    selectedWorkspace: string;
    selectedSheet: string;
    selectedRun: string | null;
}
export interface CatalogItem {
    kind: Kind;
    label: string;
    description: string;
    input: PortType | null;
    output: PortType | null;
    available: boolean;
    category: string;
}
export declare const CATALOG: readonly CatalogItem[];
export declare const LIMITS: Readonly<{
    nodes: 500;
    edges: 1000;
    files: 256;
    fileBytes: 1048576;
    totalBytes: 8388608;
    runs: 30;
    events: 4096;
    workspaces: 32;
    sheets: 64;
}>;
export declare function id(prefix?: string): string;
export declare function clone<T>(value: T): T;
export declare function bytes(text: string): number;
export declare function definition(kind: string): CatalogItem | undefined;
export declare function normalizeText(text: string): string;
export declare class DomainError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare function assert(condition: unknown, code: string, message: string): asserts condition;
export declare function safePath(path: string): string;
export declare function validateFiles(files: readonly FileData[]): void;
export declare function sha256(text: string): Promise<string>;
export declare function canonical(value: unknown): string;
/** Independent source binding used by task sessions; built-in FileData limits remain unchanged. */
export type WorkspaceBinding = {
    kind: 'inline';
    files: FileData[];
} | {
    kind: 'mounted';
    id: string;
    rootPath: string;
    access: 'read-only' | 'workspace-write';
    gitHead?: string;
};
