package main

// Keep discovery small. The detailed plan contract is available in the local
// diagnosis-first skill; runtime preflight is authoritative, not this hint.
func researchToolSchema() map[string]any {
	str := map[string]any{"type": "string"}
	integer := map[string]any{"type": "integer"}
	strings := map[string]any{"type": "array", "items": str}
	object := func(required []string, props map[string]any) map[string]any {
		return map[string]any{"type": "object", "required": required, "additionalProperties": false, "properties": props}
	}
	hypothesis := object([]string{"id", "claim", "predicts", "state"}, map[string]any{"id": str, "claim": str, "predicts": strings, "counterEvidence": strings, "state": str})
	probe := object([]string{"id", "question", "discriminates", "operations", "effect", "priority", "expectedInformation", "acceptance"}, map[string]any{"id": str, "question": str, "discriminates": strings, "operations": map[string]any{"type": "array", "items": map[string]any{"type": "object"}, "description": "Same operations as local_batch; unique IDs, read-only only (no check)."}, "effect": map[string]any{"const": "read-only"}, "priority": integer, "expectedInformation": str, "acceptance": str})
	budget := object([]string{"maxSweeps", "wallSeconds", "outputUtf8Bytes", "maxNoProgress"}, map[string]any{"maxSweeps": integer, "wallSeconds": integer, "outputUtf8Bytes": integer, "maxNoProgress": integer})
	plan := object([]string{"schema", "investigationId", "taskId", "goalRevision", "originalGoal", "planVersion", "question", "scope", "stopRules", "budget", "hypotheses", "probes"}, map[string]any{"schema": map[string]any{"const": 1}, "investigationId": str, "taskId": str, "goalRevision": integer, "originalGoal": str, "planVersion": integer, "question": str, "scope": strings, "stopRules": strings, "budget": budget, "hypotheses": map[string]any{"type": "array", "minItems": 2, "maxItems": 5, "items": hypothesis}, "probes": map[string]any{"type": "array", "minItems": 1, "maxItems": 12, "items": probe}})
	return map[string]any{"name": "diagnostic_sweep", "description": "One read-only diagnostic package via local_batch. Supply competing hypotheses and discriminating probes; original goal unchanged. Returns bounded observations with exact local evidence, NOT a root-cause verdict. Stable sweepId replays saved results. Simple requests use local_batch, no research ceremony.", "inputSchema": object([]string{"sweepId", "plan", "sourceSnapshot", "limits", "permissionScope"}, map[string]any{
		"sweepId": str, "plan": plan,
		"sourceSnapshot":  object([]string{"rootHash", "pins"}, map[string]any{"rootHash": str, "pins": map[string]any{"type": "array", "items": object([]string{"path", "sha256"}, map[string]any{"path": str, "sha256": str})}}),
		"limits":          object([]string{"outputUtf8Bytes", "wallSeconds"}, map[string]any{"outputUtf8Bytes": integer, "wallSeconds": integer}),
		"permissionScope": object([]string{"paths", "effect", "allowGit"}, map[string]any{"paths": strings, "effect": map[string]any{"const": "read-only"}, "allowGit": map[string]any{"type": "boolean"}}),
	}), "annotations": map[string]any{"readOnlyHint": true, "destructiveHint": false, "openWorldHint": false}}
}
