export type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
export declare class HostExecutionService {
    private invoke;
    constructor(invoke: Invoke);
    call<T = unknown>(operation: string, params?: Record<string, unknown>): Promise<T>;
    capabilities(): Promise<Record<string, unknown>>;
    chooseWorkspace(): Promise<unknown>;
    chooseCodex(): Promise<string | null>;
}
