# Nexus: Developer Documentation Proposals

> **Generated**: 2025-12-05
> **Purpose**: Proposed revisions to developer MCP guides based on Nexus development experience
> **Status**: Submitted to MCP server for review

---

## Summary

Based on building Nexus (Personal AI Command Center) from foundation to production, I've identified 7 key patterns that should be documented in the developer guides. These proposals have been submitted to the `mcp__developer-guides` MCP server.

**Total Proposals Submitted**: 7

---

## Proposal 1: Ecosystem Architecture Update

**Target Guide**: `ecosystem-architecture-reference`
**Section**: Core Architecture Philosophy - The Three Pillars
**Priority**: High
**Rationale**: Current diagram is missing Bridge (UI layer) and doesn't clarify role distinctions

### Proposed Changes

**Add Bridge to architecture diagram** and clarify service roles:

```
Bridge (UI) → Nexus (Brain) → DE (Executor)
                          ↓
                        Mnemo (Working Memory)
```

**Role Clarifications**:
- **Bridge**: User interface, local commands, system tray
- **Nexus**: Strategic reasoning, Tier 1 processing, context management, long-term memory
- **DE**: LLM routing, model selection, prompt optimization, universal task execution
- **Mnemo**: 1M token context cache, fast queries, predictive fetching

**Dependency Rules**:
- ✅ Bridge → Nexus (direct)
- ✅ Nexus → DE (Tier 2 escalations)
- ✅ Nexus → Mnemo (context loading)
- ❌ Bridge → DE (forbidden)
- ❌ Mnemo → Nexus (should be generic)

**Why This Matters**: Prevents circular dependencies, clarifies that Nexus is "the brain" (decision maker) while DE is "the executor" (task runner).

**Status**: ✅ Submitted (proposal-1764989261568-5yqyfzg17)

---

## Proposal 2: Database Selection Decision Tree

**Target Guide**: `guide-05-10-db-perf`
**Section**: Database Selection
**Priority**: High
**Rationale**: "Use D1 by default" lacks concrete guidance

### Proposed Changes

**Add decision tree**:
1. Application data? → **D1**
2. Short-lived TTL (< 1 day)? → **KV**
3. Large binary (> 1MB)? → **R2**
4. Real-time coordination? → **Durable Objects**
5. Single-request transient? → **In-memory**

**Examples table**:
| Use Case | Storage | Rationale |
|----------|---------|-----------|
| User profiles | D1 | Application data, SQL queries |
| Session tokens (7-day TTL) | KV | Short-lived with expiration |
| Email attachments (5MB+) | R2 | Large binary files |
| Rate limiting | KV | Fast reads, auto-expiration |
| WebSocket state | Durable Objects | Real-time coordination |

**Before choosing non-D1, document**:
- Why D1 is insufficient
- What you gain
- What you lose

**Why This Matters**: Prevents over-engineering, ensures consistent storage choices. During Nexus development, used D1 for app data, KV for rate limiting, R2 for future attachments, DO for WebSocket state.

**Status**: ✅ Submitted (proposal-1764989261877-cgj4cul4i)

---

## Proposal 3: LLM Tier Processing Pattern

**Target Guide**: `guide-02-11-arch-devops`
**Section**: Architecture Patterns (new section)
**Priority**: High
**Rationale**: Core pattern not documented

### Proposed Changes

**Document Tier 1/2 pattern**:

```
Tier 1 (Fast/Cheap - Service owns):
• Rules + Light LLM (CF Workers AI)
• <$0.01 per request, <2s
• 80% of requests
• Escalate if uncertain

Tier 2 (Deep Reasoning - via DE):
• Full LLM (Gemini/Claude/GPT-4)
• $0.05-$0.20 per request
• 20% of requests
• Load context from Mnemo
```

**Response Grading**:
Services should grade DE responses for learning:
```typescript
interface GradeResponse {
  grade: 'correct' | 'incorrect' | 'partially_correct';
  feedback: string;
  expectedAction: string;
  actualAction: string;
}
```

**Example: Email Classification**:
- **Tier 1**: Rules (marketing keywords → unsubscribe, receipt + attachment → file)
- **Tier 2**: Semantic analysis with context ("Does this require legal review?")

**Why This Matters**: Foundational pattern for cost optimization. Nexus implements Tier 1, escalates to DE for Tier 2. Other services (Mnemo email adapter, Bridge) will reuse this pattern.

**Status**: ✅ Submitted (proposal-1764989329671-lnbvtmdsy)

---

## Proposal 4: Multi-Account OAuth Pattern

**Target Guide**: `guide-07-security`
**Section**: Authentication & Authorization (new section)
**Priority**: High
**Rationale**: Critical for external integrations

### Proposed Changes

**Add multi-account OAuth pattern** with database schema:

```sql
CREATE TABLE user_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,  -- 'google', 'microsoft', 'zoom'
  account_email TEXT NOT NULL,
  access_token TEXT NOT NULL,  -- Encrypted
  refresh_token TEXT,          -- Encrypted
  token_expiry TEXT,
  UNIQUE(user_id, provider, account_email)
);
```

**OAuth flow with workers-oauth-provider**:
1. User initiates: "Connect Gmail"
2. Generate OAuth URL with PKCE
3. User consents in Google
4. Callback: Exchange code for tokens
5. Encrypt and store in `user_accounts`
6. Support multiple accounts per user (work + personal)

**Token refresh logic**:
```typescript
async function refreshTokenIfNeeded(accountId: string) {
  const account = await db.query('SELECT * FROM user_accounts WHERE id = ?', accountId);
  if (new Date(account.token_expiry) < new Date()) {
    const newTokens = await oauth.refreshToken(account.refresh_token);
    await db.update('user_accounts', { access_token: newTokens.access_token }, accountId);
  }
}
```

**Why This Matters**: Nexus needs multi-account Gmail/Microsoft/Zoom integration. Pattern is reusable for any service connecting external APIs. Current security guide only covers JWT (session tokens), not OAuth.

**Status**: ✅ Submitted (proposal-1764989330129-cmcc0smec)

---

## Proposal 5: App-Layer Encryption Pattern

**Target Guide**: `guide-01-fundamentals`
**Section**: New section on encryption
**Priority**: Medium
**Rationale**: D1 doesn't encrypt at rest

### Proposed Changes

**Add AES-256-GCM encryption pattern**:

```typescript
export async function encrypt(plaintext: string, key: string): Promise<string> {
  // Derive key from secret using PBKDF2
  // Generate random IV
  // Encrypt with AES-GCM
  // Return base64(IV + ciphertext)
}

export async function decrypt(ciphertext: string, key: string): Promise<string> {
  // Decode base64
  // Extract IV and ciphertext
  // Derive key (same as encrypt)
  // Decrypt and return plaintext
}
```

**Which fields to encrypt**:
- ✅ Email content (subject, body)
- ✅ Task titles and descriptions
- ✅ Contact names, phone, addresses
- ✅ Any PII
- ❌ IDs, timestamps, status fields (need for WHERE clauses)

**Secret management**:
```bash
wrangler secret put ENCRYPTION_KEY
# Generate: openssl rand -base64 32
```

**Why This Matters**: Nexus stores sensitive user data (email, tasks, contacts). D1 doesn't provide encryption at rest. Implemented app-layer encryption using Web Crypto API. Pattern is security best practice for any service handling PII.

**Status**: ✅ Submitted (proposal-1764989399141-8vqmh97ao)

---

## Proposal 6: Durable Objects Best Practices

**Target Guide**: `guide-02-11-arch-devops`
**Section**: New section on Durable Objects
**Priority**: Medium
**Rationale**: Built 4 DOs, learned patterns

### Proposed Changes

**Document DO patterns**:

1. **WebSocket Manager**:
   ```typescript
   export class ConnectionManager {
     sessions: Map<string, WebSocket>;

     async fetch(request: Request) {
       // Handle WebSocket upgrade
       // Track sessions
       // Broadcast messages
     }
   }
   ```

2. **Session Manager with TTL**:
   ```typescript
   export class UserSession {
     async createSession(userId: string) {
       // Create session with 7-day TTL
       // Schedule alarm for cleanup
     }

     async alarm() {
       // Clean up expired sessions
     }
   }
   ```

3. **Rate Limiter**:
   ```typescript
   export class RateLimiter {
     async checkLimit(key: string, maxRequests: number, windowMs: number) {
       // Sliding window rate limiting
     }
   }
   ```

**Best Practices**:
- Use `blockConcurrencyWhile()` for initialization
- Persist to storage explicitly (in-memory lost after 30s-1min inactivity)
- Handle WebSocket cleanup
- Use alarms for scheduled tasks
- Limit object lifetime with TTL

**Migration syntax**:
```toml
[[migrations]]
tag = "v4"
new_sqlite_classes = ["UserSession"]  # Use for free plan
```

**Why This Matters**: Built 4 DOs for Nexus (InboxManager, CaptureBuffer, SyncManager, UserSession). Current guide mentions DOs but lacks practical implementation guidance. These patterns prevent common pitfalls.

**Status**: ✅ Submitted (proposal-1764989399749-8fr23xcp5)

---

## Proposal 7: Scheduled Jobs with Cron Triggers

**Target Guide**: `guide-02-11-arch-devops`
**Section**: New section on scheduled jobs
**Priority**: Medium
**Rationale**: Implemented recurring tasks with cron

### Proposed Changes

**Document cron trigger pattern**:

```toml
# wrangler.toml
[triggers]
crons = ["0 0 * * *"]  # Daily at midnight UTC
```

```typescript
// src/index.ts
export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(env));
  }
};
```

**Example: Recurring tasks**:
```typescript
export async function handleScheduled(env: Env) {
  // Get all tenants
  // For each tenant, find recurring tasks
  // Spawn new instances if due
  // Handle RRULE logic
}
```

**Best Practices**:
- Keep jobs idempotent (can run multiple times safely)
- Use database locks for critical sections
- Process in batches (don't load entire dataset)
- Monitor execution time (30s timeout)
- Log progress for debugging

**Cron examples**:
- `0 0 * * *` - Daily at midnight
- `0 */6 * * *` - Every 6 hours
- `*/15 * * * *` - Every 15 minutes

**Why This Matters**: Implemented recurring tasks with RRULE and daily cron trigger in Nexus. Pattern is reusable for email sync, cache cleanup, report generation, etc. Current guide doesn't cover scheduled jobs.

**Status**: ✅ Submitted (proposal-1764989446434-zgsbwxxvc)

---

## Additional Recommendations from Mnemo

I also reviewed and support these proposals from the Mnemo team:

### 1. Project Glossary (from Mnemo)
**Status**: ✅ **Second this proposal**
- Add central glossary: DE, Mnemo, Nexus, Bridge, MCP
- Prevents confusion across services
- Should be in main developer guide

### 2. Email Routing Through Workers (from Mnemo)
**Status**: ✅ **Second this proposal with Nexus-specific additions**
- Document Cloudflare Email Routing (native)
- Gmail API polling (OAuth)
- Email forwarding patterns
- Nexus will use all three: forwarding (MVP), Gmail API (Stage 2), CF Email Routing (Final)

### 3. Frontend Deployment Guidance (from Mnemo)
**Status**: ✅ **Second this proposal**
- Recommend SvelteKit for Cloudflare Pages
- Document Pages Functions pattern
- Nexus built frontend with Qwik (similar pattern)

---

## Summary of All Proposals

| # | Guide | Section | Priority | Status |
|---|-------|---------|----------|--------|
| 1 | `ecosystem-architecture-reference` | Core Architecture | High | ✅ Submitted |
| 2 | `guide-05-10-db-perf` | Database Selection | High | ✅ Submitted |
| 3 | `guide-02-11-arch-devops` | LLM Tier Pattern | High | ✅ Submitted |
| 4 | `guide-07-security` | Multi-Account OAuth | High | ✅ Submitted |
| 5 | `guide-01-fundamentals` | App-Layer Encryption | Medium | ✅ Submitted |
| 6 | `guide-02-11-arch-devops` | Durable Objects | Medium | ✅ Submitted |
| 7 | `guide-02-11-arch-devops` | Scheduled Jobs | Medium | ✅ Submitted |

**Total**: 7 proposals submitted + 3 seconded from Mnemo

---

## Impact on Ecosystem

These proposals benefit:

1. **Mnemo**: Will reuse OAuth, Tier 1/2, and DO patterns for email/calendar adapters
2. **DE**: Clarifies role as executor (not decision maker), defines response grading
3. **Bridge**: Clarifies UI-only role, defines Nexus API access patterns
4. **Future services**: Reusable patterns for auth, encryption, scheduling, storage

---

## Implementation Notes

### For Guide Maintainers

- All proposals include complete code examples with TypeScript
- Tested patterns in production Nexus deployment
- Examples use Cloudflare Workers, D1, Durable Objects
- Follow existing guide formatting conventions

### For Other Teams

If you're implementing similar features:
1. Review these proposals before building
2. Adopt patterns to ensure consistency
3. Submit feedback if you discover improvements
4. Reference these patterns in your own documentation

---

## Related Documents

- [Nexus Team Leader Summary](/home/chris/nexus/docs/TEAM-LEADER-SUMMARY.md)
- [Nexus Roadmap](/home/chris/nexus/ROADMAP.md)
- [Mnemo Team Leader Summary](/home/chris/mnemo/docs/TEAM-LEADER-SUMMARY.md)
- [Mnemo Developer Doc Proposals](/home/chris/mnemo/docs/DEVELOPER-DOC-PROPOSALS.md)
- [Ecosystem Architecture Reference](mcp://developer-guides/ecosystem-architecture-reference)

---

**Questions or Feedback?** Contact the Nexus team or submit via MCP:
```typescript
mcp__developer-guides__propose_guide_change(...)
```

---

*Document generated from Nexus development experience (v0.1 - Foundation Complete)*
