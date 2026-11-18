/** Proposed boundary, not an implemented transport. UI never sends arbitrary shell strings. */
export type Id = string;
export type Provenance = 'user' | 'local-observation' | 'codex-event' | 'model-claim' | 'scenario';
export type Observed<T> = { known: true; value: T; source: Provenance; observedAt: string }
  | { known: false; reason: string };
export interface GoalRevision { taskId: Id; revision: number; original: string; obligations: ReadonlyArray<{ id: Id; text: string; origin: 'explicit-user' | 'proposed-inference' }>; }
export interface ConversationRef { family: 'codex-thread' | 'external-web-chat'; profileId: Id; conversationId: Id; parentMessageId?: Id; verifiedAt?: string; }
export interface CommandBase { commandId: Id; projectId: Id; taskId: Id; goalRevision: number; requesterRole: 'assistant' | 'worker' | 'verifier' | 'owner'; expectedGeneration: number; }
export type Command =
 | (CommandBase & { kind: 'turn.start'; thread: ConversationRef; promptRevision: number; prompt: string; permissionProfileId: Id })
 | (CommandBase & { kind: 'turn.steer'; thread: ConversationRef; expectedTurnId: Id; text: string })
 | (CommandBase & { kind: 'turn.interrupt'; thread: ConversationRef; turnId: Id })
 | (CommandBase & { kind: 'command.reconcile'; originalCommandId: Id })
 | (CommandBase & { kind: 'project.snapshot'; sourceBindingId: Id })
 | (CommandBase & { kind: 'tool.invoke'; registeredOperationId: Id; permissionGrantId: Id; arguments: unknown })
 | (CommandBase & { kind: 'result.propose'; baseVersion: Id; artifactHash: string })
 | (CommandBase & { kind: 'result.publish'; baseVersion: Id; artifactHash: string; acceptanceId: Id; expectedTargetVersion: Id });
export interface CommandReceipt { commandId: Id; state: 'recorded' | 'dispatched' | 'confirmed' | 'outcome-unknown' | 'rejected'; turnId?: Id; reason?: string; }
export interface Capability { operation: Command['kind'] | 'sessions.list' | 'sessions.read' | 'events.read'; status: 'available' | 'unverified' | 'unavailable'; profile: 'read-only' | 'delegated-codex' | 'isolated-native'; reason?: string; }
export interface RuntimeEvent { eventId: Id; sequence: number; commandId?: Id; threadId?: Id; turnId?: Id; at: string; provenance: Provenance; kind: string; payload: unknown; coverage?: string; }
export interface ExecutionService {
 capabilities(): Promise<ReadonlyArray<Capability>>;
 sessions(profileId: Id, cursor?: string): Promise<{items: ReadonlyArray<ConversationRef>; nextCursor?: string; coverage: string}>;
 execute(command: Command): Promise<CommandReceipt>;
 reconcile(commandId: Id): Promise<CommandReceipt>; // Read-only; not an alias for execute.
 events(afterSequence: number): AsyncIterable<RuntimeEvent>;
}
