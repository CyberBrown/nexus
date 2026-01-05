# Nexus → DE Routing Architecture Investigation

**Date:** 2025-12-27
**Status:** ✅ FIXED (2026-01-05)

## Summary

~~Nexus is **bypassing PrimeWorkflow** in two locations. There are **zero references** to calling `de-workflows.../execute` anywhere in the codebase.~~

**FIXED:** Nexus now routes all code execution through `POST /execute` on de-workflows, which goes through PrimeWorkflow for proper classification and sub-workflow routing.

### Changes Made:
1. `src/workflows/TaskExecutorWorkflow.ts` - Changed from INTAKE_URL/intake to DE_WORKFLOWS_URL/execute
2. `wrangler.toml` and `wrangler.nexus-mcp.toml` - Enabled DE_WORKFLOWS_URL, deprecated INTAKE_URL
3. `src/types/index.ts` - Updated comments to reflect DE_WORKFLOWS_URL as primary entry point

---

## Bypass Locations Found

### 1. `src/scheduled/task-executor.ts:657` - `executeCodeTaskViaWorkflow()`

```typescript
const response = await fetch(`${workflowsUrl}/workflows/code-execution`, {
```

**Path:** Cron executor → code task without sandbox → **BYPASS** to `/workflows/code-execution`

### 2. `src/mcp/index.ts:376-378` - `nexus_create_task` with auto_dispatch

```typescript
const workflowUrl = `${env.DE_WORKFLOWS_URL}/workflows/code-execution`;
const workflowResponse = await fetch(workflowUrl, {
```

**Path:** MCP tool creates task with `auto_dispatch=true` → **BYPASS** to `/workflows/code-execution`

---

## Correct Paths (Not Bypassing)

| Location | Endpoint | Target |
|----------|----------|--------|
| `TaskExecutorWorkflow.ts:404` | `${sandboxUrl}/execute` | sandbox-executor ✅ |
| `sandbox-client.ts:158` | `/execute` | sandbox-executor ✅ |

These correctly call **sandbox-executor** `/execute`, not de-workflows.

---

## Configuration in `wrangler.toml`

```toml
DE_WORKFLOWS_URL = "https://de-workflows.solamp.workers.dev"  # Used for BYPASS
SANDBOX_EXECUTOR_URL = "https://sandbox-executor.solamp.workers.dev"  # Correct
```

---

## Current Routing Diagram (WRONG)

```
┌─────────────────────────────────────────────────────────────────┐
│                           NEXUS                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Cron Executor (task-executor.ts)                               │
│  ├─ sandbox available?                                          │
│  │   YES → sandbox-executor/execute ✅                          │
│  │   NO  → isCodeTask()?                                        │
│  │         YES → de-workflows/workflows/code-execution ❌ BYPASS│
│  │         NO  → de-text-gen (service binding) ✅               │
│  │                                                               │
│  MCP nexus_create_task (auto_dispatch=true)                     │
│  └─ executor_type='ai'?                                         │
│       YES → de-workflows/workflows/code-execution ❌ BYPASS     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │      de-workflows             │
              │  /workflows/code-execution    │
              │  (CodeExecutionWorkflow)      │
              │                               │
              │  ⚠️ PrimeWorkflow SKIPPED!   │
              └───────────────────────────────┘
```

---

## Expected Architecture (CORRECT)

```
┌─────────────────────────────────────────────────────────────────┐
│                           NEXUS                                  │
├─────────────────────────────────────────────────────────────────┤
│  ALL task execution should go through:                          │
│                                                                  │
│  POST de-workflows.solamp.workers.dev/execute                   │
│       └─ PrimeWorkflow routes to correct sub-workflow           │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │      de-workflows             │
              │  POST /execute                │
              │         │                     │
              │         ▼                     │
              │    PrimeWorkflow              │
              │    ├─ analyze task            │
              │    └─ route to:               │
              │       ├─ CodeExecutionWF      │
              │       ├─ TextGenerationWF     │
              │       └─ etc.                 │
              └───────────────────────────────┘
```

---

## Files Requiring Changes

1. **`src/scheduled/task-executor.ts`**
   - Change `executeCodeTaskViaWorkflow()` to call `/execute` instead of `/workflows/code-execution`

2. **`src/mcp/index.ts`**
   - Change `nexus_create_task` auto_dispatch to call `/execute` instead of `/workflows/code-execution`

3. **Both need to send appropriate metadata** so PrimeWorkflow can route correctly

---

## Request Payload Considerations

Current bypass payload:
```json
{
  "id": "task_id",
  "params": {
    "task_id": "...",
    "prompt": "...",
    "repo_url": "...",
    "preferred_executor": "claude",
    "timeout_ms": 600000
  }
}
```

PrimeWorkflow `/execute` likely expects different structure - need to check DE's expected schema.
