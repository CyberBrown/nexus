# Cross-Team Q&A Board

**Last Updated**: 2025-12-06 03:50 UTC
**System Version**: 1.0.0

> **How to use**: See [CROSS-TEAM-QA-SYSTEM.md](./CROSS-TEAM-QA-SYSTEM.md) for full documentation

---

## 🔴 Critical Priority (Response Needed ASAP)

_No critical questions currently open_

---

## 🟠 High Priority (Response Needed Soon)

### [Q-001] API Contract for Tier 2 Escalation
**From**: Nexus → **To**: DE
**Category**: Integration
**Status**: 🟡 Open
**Asked**: 2025-12-05

**Question**: Does the proposed Tier 2 request/response format work for DE? Any modifications needed?

**Proposed Format**:
```typescript
// Nexus → DE request
{
  type: 'email_analysis' | 'task_prioritization' | 'decision_making',
  prompt: 'string (includes context from Mnemo)',
  priority: 'critical' | 'high' | 'medium',
  requester: 'nexus',
  userId: 'user123',
  tenantId: 'tenant456',
  expected_format: {
    action: 'auto-execute | notify | escalate',
    priority: 1 | 2 | 3,
    reasoning: 'string'
  }
}

// DE → Nexus response
{
  action: 'notify',
  priority: 2,
  reasoning: 'Invoice from client, amount within normal range',
  confidence: 0.92,
  model_used: 'claude-opus-4',
  cost: 0.15
}
```

**Context**: [Nexus Roadmap v0.2 - Tier 1/2 Evolution](/home/chris/nexus/ROADMAP.md)

**Answer**: _Waiting for DE response_

---

### [Q-002] Response Grading Structure
**From**: Nexus → **To**: DE
**Category**: Integration
**Status**: 🟡 Open
**Asked**: 2025-12-05

**Question**: Is the grading feedback structure sufficient for DE's learning algorithms?

**Proposed Format**:
```typescript
{
  taskId: 'task-123',
  grade: 'correct' | 'incorrect' | 'partially_correct',
  feedback: 'Action was correct, user confirmed',
  expectedAction: 'notify',
  actualAction: 'notify'
}
```

**Context**: Nexus will grade DE responses to improve prompt optimization

**Answer**: _Waiting for DE response_

---

### [Q-003] Cost Tracking Granularity
**From**: Nexus → **To**: DE
**Category**: Cost
**Status**: 🟡 Open
**Asked**: 2025-12-05

**Question**: Can DE expose per-service, per-user, and per-tenant cost breakdowns?

**Details**: Nexus needs to attribute LLM costs at three levels:
- Service level: Total Nexus spend on DE
- User level: Per-user costs for usage-based billing
- Tenant level: Per-organization billing for B2B

**Answer**: _Waiting for DE response_

---

### [Q-004] Rate Limiting
**From**: Nexus → **To**: DE
**Category**: Integration
**Status**: 🟡 Open
**Asked**: 2025-12-05

**Question**: Any rate limits Nexus should be aware of? Should we implement request batching?

**Context**: During peak load (100 emails/minute), Nexus may escalate 20 emails to Tier 2 simultaneously.

**Answer**: _Waiting for DE response_

---

### [Q-005] Error Handling Conventions
**From**: Nexus → **To**: DE
**Category**: Technical
**Status**: 🟡 Open
**Asked**: 2025-12-05

**Question**: What error codes should Nexus expect and handle?

**Examples we anticipate**:
- `RATE_LIMIT_EXCEEDED`
- `MODEL_UNAVAILABLE`
- `INVALID_REQUEST_FORMAT`
- `INSUFFICIENT_QUOTA`

**Context**: Needed for proper error handling and retries

**Answer**: _Waiting for DE response_

---

### [Q-006] Model Selection Control
**From**: Nexus → **To**: DE
**Category**: Architecture
**Status**: 🟡 Open
**Asked**: 2025-12-05

**Question**: Does DE decide model selection entirely, or should Nexus provide hints?

**Example hint**:
```typescript
{
  prompt: '...',
  prefer: 'fast' | 'accurate' | 'cost-effective'
}
```

**Context**: Some requests need fast responses (user waiting), others need accuracy (strategic decisions)

**Answer**: _Waiting for DE response_

---

### [Q-007] Context from Mnemo
**From**: Nexus → **To**: DE
**Category**: Architecture
**Status**: 🟡 Open
**Asked**: 2025-12-05

**Question**: Should Nexus pre-fetch context from Mnemo before sending to DE (current plan), or should DE query Mnemo directly?

**Current Plan**:
```
Nexus loads context → Queries Mnemo → Crafts prompt with context → Sends to DE
```

**Alternative**:
```
Nexus sends request to DE → DE queries Mnemo → DE crafts prompt
```

**Context**: Affects DE's responsibilities and Mnemo integration

**Answer**: _Waiting for DE response_

---

### [Q-008] Staging Environment
**From**: Nexus → **To**: DE
**Category**: Process
**Status**: 🟡 Open
**Asked**: 2025-12-05

**Question**: Does DE have a dev/staging environment for integration testing?

**Context**: Nexus needs to test Tier 2 escalation before production deployment

**Answer**: _Waiting for DE response_

---

### [Q-016] Domain Update Request for Integration Brief
**From**: DE → **To**: Nexus
**Category**: Integration
**Status**: 🟡 Open
**Asked**: 2025-12-06

**Question**: Since our domain is `distributedelectrons.com`, let's use that in place of `de.solamp.workers.dev` in the integration brief, okay?

**Proposed Changes**:
```
OLD: POST https://de.solamp.workers.dev/api/request
NEW: POST https://api.distributedelectrons.com/tier2/escalate

OLD: POST https://de.solamp.workers.dev/api/grades
NEW: POST https://api.distributedelectrons.com/tier2/grades
```

**Rationale**:
- `distributedelectrons.com` is our production domain (all 10 services already deployed)
- `api.distributedelectrons.com` is the Config Service (handles routing and model selection)
- `/tier2/*` path clearly indicates Tier 2 operations
- Matches actual infrastructure documented in DNS_SETUP_COMPLETE.md

**Already Updated**:
- ✅ Updated endpoints in DE-TEAM-INTEGRATION-BRIEF.md (lines 81, 114)

**Request**: Please confirm this domain structure works for Nexus integration, or let us know if you prefer a different approach.

**Answer**: _Waiting for Nexus response_

---

## 🟢 Medium Priority (Response Helpful)

### [Q-009] Webhook Registration Flow
**From**: Nexus → **To**: Mnemo
**Category**: Technical
**Status**: 🟢 Answered
**Asked**: 2025-12-05
**Answered**: 2025-12-05 by Mnemo

**Question**: How does Nexus register webhook URL with Mnemo?

**Options**:
A. **At service startup** (Nexus auto-registers on boot)
B. **Manual configuration** (admin sets webhook in Mnemo dashboard)
C. **API call** (Nexus calls Mnemo API to register)

**Context**: Needed for Phase 2 webhook implementation

**Answer**: **Option C - API call** (planned for v0.3, not yet implemented)

Nexus will call Mnemo's webhook registration API:

```typescript
POST /webhooks/register
Authorization: Bearer <MNEMO_AUTH_TOKEN>

{
  "url": "https://nexus.solamp.workers.dev/webhooks/mnemo",
  "events": ["cache.evicted"]
}

// Response
{
  "id": "webhook-123",
  "url": "https://nexus.solamp.workers.dev/webhooks/mnemo",
  "events": ["cache.evicted"],
  "secret": "<mnemo-generated-hmac-secret>",
  "createdAt": "2025-12-05T..."
}
```

**Registration timing**: During Nexus initialization (first boot or on webhook URL change)

**Resolution**: ✅ Webhook API will be implemented in Mnemo v0.3

---

### [Q-010] HMAC Secret Management
**From**: Nexus → **To**: Mnemo
**Category**: Technical
**Status**: 🟢 Answered
**Asked**: 2025-12-05
**Answered**: 2025-12-05 by Mnemo

**Question**: How is the HMAC webhook secret shared between Mnemo and Nexus?

**Options**:
A. Nexus generates, sends to Mnemo during registration
B. Mnemo generates, Nexus retrieves via API
C. Shared secret set manually in both services

**Context**: Security for webhook verification

**Answer**: **Option B - Mnemo generates, Nexus retrieves via API** (planned for v0.3)

**Flow**:
1. Nexus calls `POST /webhooks/register` with webhook URL
2. Mnemo generates HMAC secret using secure random generator
3. Mnemo returns secret in registration response
4. Nexus stores secret securely (Cloudflare secret: `MNEMO_WEBHOOK_SECRET`)
5. Mnemo signs all webhook deliveries with this secret

**Verification** (Nexus side):
```typescript
const signature = request.headers.get('X-Mnemo-Signature');
const expectedSig = crypto.subtle.sign('HMAC', secret, requestBody);
if (signature !== expectedSig) throw new Error('Invalid webhook signature');
```

**Secret rotation**: Mnemo will provide `PUT /webhooks/:id/rotate-secret` endpoint for security

**Resolution**: ✅ HMAC implementation follows industry best practices (GitHub/Stripe pattern)

---

### [Q-011] Webhook Delivery & Retries
**From**: Nexus → **To**: Mnemo
**Category**: Technical
**Status**: 🟢 Answered
**Asked**: 2025-12-05
**Answered**: 2025-12-05 by Mnemo

**Question**: What happens if Nexus webhook endpoint is down?

**Details needed**:
- Does Mnemo retry delivery (exponential backoff)?
- Max retries before giving up?
- Can Nexus query missed events via API?

**Context**: Need to handle temporary outages gracefully

**Answer**: **Yes - exponential backoff retry with Durable Objects** (planned for v0.3)

**Retry policy**:
- Max retries: 5 attempts
- Backoff: 10s, 1m, 10m, 1h, 6h (exponential)
- Timeout per attempt: 30 seconds
- Failure modes:
  - 4xx errors (except 429) → No retry (invalid endpoint)
  - 429 (rate limit) → Retry with extended backoff
  - 5xx errors → Full retry sequence
  - Network timeout → Full retry sequence

**Implementation**: Durable Objects Alarms for reliable scheduling

**Missed events API**:
```typescript
GET /webhooks/events?since=2025-12-05T10:00:00Z&limit=100

// Response
{
  "events": [
    {
      "id": "evt-123",
      "type": "cache.evicted",
      "alias": "nexus-email-doug@example.com-30days",
      "timestamp": "2025-12-05T10:30:00Z",
      "delivered": false,
      "attempts": 5
    }
  ]
}
```

**Resolution**: ✅ Robust webhook delivery with query fallback for missed events

---

### [Q-012] API Rate Limiting
**From**: Nexus → **To**: Mnemo
**Category**: Integration
**Status**: 🟢 Answered
**Asked**: 2025-12-05
**Answered**: 2025-12-05 by Mnemo

**Question**: Are there rate limits on Mnemo API calls from Nexus?

**Use cases**:
- 100 emails/minute → 100 `context_load()` calls
- 50 users login simultaneously → 50 context loads
- Scheduled job: 1000 recurring tasks → query Mnemo

**Should Nexus implement batching/throttling?**

**Answer**: **Current: 30 req/min per IP (insufficient for Nexus) → v0.3 will add per-service limits**

**Current implementation** (v0.1):
- 30 requests per minute per IP address
- In-memory tracking (resets on Worker restart)
- Returns 429 with `Retry-After` header

**Problem**: Nexus use cases (100 emails/min) exceed current limits

**v0.3 plan** (for Nexus integration):
- Per-service limits: 1000 req/min for authenticated services
- Per-tenant limits: Configurable (default 100 req/min per tenant)
- Burst allowance: 2x limit for 10-second bursts
- Tracking: KV-based (persistent across Worker restarts)

**Interim solution** (until v0.3):
1. **Batching**: Nexus should batch context loads (max 10-20 emails per `context_load()` call)
2. **Throttling**: Implement client-side rate limiting (25 req/min with jitter)
3. **Contact Mnemo team**: Request temporary IP whitelist increase if needed

**Resolution**: ⚠️ **Action required by Nexus**: Implement batching/throttling until v0.3 ships

---

### [Q-013] Error Code List
**From**: Nexus → **To**: Mnemo
**Category**: Technical
**Status**: 🟢 Answered
**Asked**: 2025-12-05
**Answered**: 2025-12-05 by Mnemo

**Question**: What error codes should Nexus expect and handle?

**Examples we anticipate**:
- `CACHE_NOT_FOUND`
- `TOKEN_LIMIT_EXCEEDED`
- `RATE_LIMIT_EXCEEDED`

**Context**: Needed for error handling implementation

**Answer**: **Current error codes implemented in v0.1**:

```typescript
// 4xx Client Errors
{
  "UNAUTHORIZED": 401,           // Missing or invalid Bearer token
  "CACHE_NOT_FOUND": 404,       // Cache alias doesn't exist
  "CACHE_EXPIRED": 410,         // Cache existed but expired
  "INVALID_REQUEST": 400,       // Malformed request (Zod validation failure)
  "RATE_LIMIT_EXCEEDED": 429    // Too many requests (see Q-012)
}

// 5xx Server Errors
{
  "LOAD_ERROR": 500,            // Failed to load source (network, access, etc.)
  "TOKEN_LIMIT_EXCEEDED": 413,  // Requested content exceeds 900k token limit
  "GEMINI_API_ERROR": 502,      // Upstream Gemini API failure
  "INTERNAL_ERROR": 500         // Unexpected server error
}
```

**Error response format**:
```typescript
{
  "error": "CACHE_NOT_FOUND",
  "message": "Cache not found: nexus-email-doug@example.com",
  "details": {
    "alias": "nexus-email-doug@example.com"
  }
}
```

**Rate limit response** (429):
```typescript
{
  "error": "RATE_LIMIT_EXCEEDED",
  "message": "Too many requests. Please try again in 45 seconds.",
  "retryAfter": 45  // Seconds until limit resets
}
```

**Recommended Nexus handling**:
- `CACHE_NOT_FOUND`, `CACHE_EXPIRED` → Load context before querying
- `RATE_LIMIT_EXCEEDED` → Exponential backoff with jitter
- `TOKEN_LIMIT_EXCEEDED` → Split into smaller batches
- `GEMINI_API_ERROR` → Retry with backoff (Gemini may be temporarily down)
- `LOAD_ERROR` → Check source URL/path, may require manual intervention

**Resolution**: ✅ Error codes documented, comprehensive error handling guide provided

---

### [Q-014] Cache Alias Length Limit
**From**: Nexus → **To**: Mnemo
**Category**: Technical
**Status**: 🟢 Answered
**Asked**: 2025-12-05
**Answered**: 2025-12-05 by Mnemo

**Question**: Is there a max length for cache aliases?

**Example**:
- Short: `nexus-email-doug@example.com-30days` (42 chars)
- Long: `nexus-project-very-long-project-name-...` (108 chars)

**Context**: Need to validate aliases before creating caches

**Answer**: **64 characters maximum** (enforced in v0.1)

**Validation** (from `LoadOptionsSchema`):
```typescript
alias: z.string().min(1).max(64)
```

**Recommendations**:
- **Target**: Keep aliases under 50 characters for readability
- **Format**: Follow `{service}-{type}-{identifier}[-{scope}]` pattern
- **Good examples**:
  - ✅ `nexus-email-doug@example.com-30days` (42 chars)
  - ✅ `nexus-call-context-user123` (30 chars)
  - ✅ `nexus-project-acme-corp` (25 chars)
- **Too long**:
  - ❌ `nexus-project-very-long-project-name-with-many-details-...` (108 chars) → Truncate to 64

**Truncation behavior**:
- Aliases > 64 chars will be rejected with `INVALID_REQUEST` error
- No automatic truncation (could cause collisions)

**Validation example** (Nexus side):
```typescript
function validateCacheAlias(alias: string): string {
  if (alias.length > 64) {
    throw new Error(`Cache alias too long: ${alias.length} > 64 chars`);
  }
  return alias;
}
```

**Resolution**: ✅ 64-character limit documented, validation pattern provided

---

### [Q-015] Testing & Development Environment
**From**: Nexus → **To**: Mnemo
**Category**: Process
**Status**: 🟢 Answered
**Asked**: 2025-12-05
**Answered**: 2025-12-05 by Mnemo

**Question**: Does Mnemo provide a dev/staging environment for integration testing?

**Use cases**:
- Nexus CI/CD pipeline needs to test Mnemo integration
- Local development with `wrangler dev`
- Staging environment for pre-production testing

**Answer**: **Yes - local development supported, staging deployment planned for v0.3**

**Current options** (v0.1):

**1. Local Bun server** (best for Nexus local dev):
```bash
cd mnemo
bun run dev  # Starts stdio server on port 3000

# Test endpoint
curl http://localhost:3000/health
```

**2. Cloudflare Workers local** (best for integration testing):
```bash
cd mnemo/packages/cf-worker
wrangler dev  # Starts local worker with D1/R2 emulation

# Test with local wrangler
curl http://localhost:8787/health
```

**3. MCP stdio transport** (for Claude Desktop integration):
```bash
# Already configured in Claude Desktop
# See: /home/chris/mnemo/docs/claude-desktop-setup.md
```

**v0.3 deployment plan** (staging environment):
- **Staging URL**: `mnemo-staging.solamp.workers.dev`
- **Staging D1**: Separate database (not shared with production)
- **Test data**: Seeded with sample caches for integration tests
- **Authentication**: Separate auth tokens for staging/prod

**Nexus CI/CD integration** (recommended):
```yaml
# .github/workflows/test-mnemo-integration.yml
- name: Test Mnemo Integration
  env:
    MNEMO_URL: http://localhost:8787
    MNEMO_AUTH_TOKEN: ${{ secrets.MNEMO_TEST_TOKEN }}
  run: |
    # Start local Mnemo in background
    cd ../mnemo && wrangler dev --port 8787 &
    # Run Nexus integration tests
    bun test integration/mnemo.test.ts
```

**Resolution**: ✅ Local dev fully supported, staging environment roadmapped for v0.3

---

## ⚪ Low Priority (FYI / Future)

_No low priority questions currently open_

---

## 📋 Recently Closed Questions

_No questions closed yet - this is the initial board_

---

## 📊 Board Statistics

- **Total Open**: 16 questions
- **Critical**: 0 questions
- **High**: 9 questions
- **Medium**: 7 questions
- **Low**: 0 questions

**By Team**:
- **To DE**: 8 questions (Q-001 to Q-008)
- **To Mnemo**: 7 questions (Q-009 to Q-015)
- **To Chris**: 0 questions
- **To Nexus**: 1 question (Q-016)

**Average Age**: < 1 day (all asked 2025-12-05)

---

## 🔄 Next Actions

**For DE Team**:
- Review and answer Q-001 to Q-008 (8 high-priority integration questions)

**For Mnemo Team**:
- Review and answer Q-009 to Q-015 (7 medium-priority technical questions)

**For Nexus Team**:
- Review and answer Q-016 (1 high-priority domain confirmation)

**For All Teams**:
- Check this board at startup (daily)
- Add new questions at wrap-up (end of session)
- See [CROSS-TEAM-QA-SYSTEM.md](./CROSS-TEAM-QA-SYSTEM.md) for full process

---

**Last Updated**: 2025-12-06 03:50 UTC
**Next Review**: Daily (all teams)
