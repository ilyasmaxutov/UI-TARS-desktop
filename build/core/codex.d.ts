import { Goal } from './model.js';
/** Protocol builder only. No connection, no credential use, no unisolated process launch. */
export declare function codexInitialize(requestId: number): {
    id: number;
    method: string;
    params: {
        clientInfo: {
            name: string;
            title: string;
            version: string;
        };
        capabilities: {
            experimentalApi: boolean;
        };
    };
};
export declare function codexThread(requestId: number, cwd: string): {
    id: number;
    method: string;
    params: {
        cwd: string;
        approvalPolicy: string;
        sandbox: string;
    };
};
export declare function codexSteer(requestId: number, threadId: string, turnId: string, text: string): {
    id: number;
    method: string;
    params: {
        threadId: string;
        expectedTurnId: string;
        input: {
            type: string;
            text: string;
        }[];
    };
};
export declare function codexInterrupt(requestId: number, threadId: string, turnId: string): {
    id: number;
    method: string;
    params: {
        threadId: string;
        turnId: string;
    };
};
export declare function supervisorContract(goal: Goal): string;
