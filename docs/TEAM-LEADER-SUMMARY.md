# Nexus: Team Leader Summary

> **Audience**: Team leaders for DE, Mnemo, Bridge, and other services
> **Generated**: 2025-12-05
> **Purpose**: Understanding Nexus's role and how to integrate with it

---

## Executive Summary

**Nexus** is the **strategic reasoning and organization layer** for the entire ecosystem. It serves as "the brain" that gathers, sorts, contextualizes, and makes high-level decisions about communication, time management, projects, and tasks.

**Think of Nexus as**: The master organizer with long-term memory. It processes 10-20 projects, 50+ goals, hundreds of daily communications (email, text, calls, meetings), and synthesizes them into actionable priorities. Nexus owns Tier 1 processing (fast classification), delegates complex reasoning to DE (Tier 2), and manages context between short-term memory (Mnemo) and long-term storage (D1).

---

## What Nexus Does

### Core Capabilities

1. **Communication Management**
   - **Email ingestion**: Gmail (multi-account), Outlook, forwarded emails
   - **Text messages**: SMS via Telnyx/Zoom Phone
   - **Social media**: (future) WhatsApp, Facebook Messenger, etc.
   - **Phone calls**: Transcriptions via Zoom/Telnyx
   - **Meeting notes**: Zoom recordings and transcriptions
   - **Tier 1 classification**: Rules-based + light LLM (CF Workers AI or Claude API)
   - **Auto-filing**: Spam → delete, receipts → file, important → escalate

2. **Time Management**
   - **Calendar integration**: Google Calendar, Outlook Calendar (multi-account)
   - **Scheduling decisions**: Client dinner vs gym → learns user patterns
   - **Availability checking**: Automated conflict resolution
   - **Event context**: Load meeting notes, attendee history from Mnemo

3. **Project & Task Orchestration**
   - **CRUD for all entities**: Tasks, projects, ideas, people, commitments
   - **Recurring tasks**: RRULE-based scheduling with cron triggers
   - **Ideas capture**: "Make dog translator app" → analyze, prioritize, backlog
   - **Strategy/tactics analysis**: Long-term goals, resource allocation
   - **Autonomous agent delegation**: "Build feature X" → assign to swarm

4. **Context Management (Nexus ↔ Mnemo)**
   - **Decide what's HOT**: Client email thread → load into Mnemo for quick access
   - **Decide what's COLD**: Marketing spam → don't load into short-term memory
   - **Proactive loading**: Phone call with Doug → load Doug's CRM profile, past emails, meeting notes into Mnemo
   - **Pattern learning**: User prioritizes client over gym, daughter over client → store patterns
   - **Context switching**: Project X mentioned → load X's repo, docs, tasks into Mnemo

5. **Decision Making**
   - **When to escalate**: Tier 1 → Tier 2 (DE) when semantic understanding needed
   - **Prompt engineering**: Craft precise prompts for DE ("Client asking for discount, check past pricing")
   - **Response grading**: Score DE responses to improve global best practices
   - **Pattern synthesis**: Learn user preferences, recurring patterns, priorities

### What Nexus Does NOT Do

- ❌ LLM routing/selection (that's DE's job)
- ❌ UI rendering (that's Bridge's job)
- ❌ Short-term memory storage (that's Mnemo's job)
- ❌ Universal task execution (that's DE's job)

---

## How Your Service Interacts with Nexus

### For Bridge (Frontend UI)

**Your role**: Display information to users, capture user input, execute local commands

**How you use Nexus**:
- **Fetch data**: GET `/api/tasks`, `/api/inbox`, `/api/projects`, etc.
- **Create/update**: POST/PATCH `/api/tasks`, `/api/ideas`, etc.
- **Real-time updates**: WebSocket to InboxManager, SyncManager for live changes
- **Capture input**: Voice/text capture → POST `/api/capture` (Nexus classifies and routes)
- **Execute local commands**: Send email, open file, system tray notifications

**Integration pattern**:
```typescript
// Bridge component fetching tasks
async function fetchTodayTasks() {
  const response = await fetch('https://nexus.solamp.workers.dev/api/tasks?status=today', {
    headers: { 'Authorization': `Bearer ${userToken}` }
  });
  const tasks = await response.json();
  return tasks;
}

// Capture voice input
async function captureVoiceInput(audioChunk: Blob) {
  const response = await fetch('https://nexus.solamp.workers.dev/api/capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: await transcribe(audioChunk),
      source_type: 'voice'
    })
  });
  // Nexus classifies, creates task/idea/reminder, returns result
}
```

**Key considerations**:
- Bridge talks directly to Nexus (not through DE)
- Use WebSocket for real-time updates (inbox, sync status)
- Handle local commands (send email, text) via Bridge's system-level access
- For complex queries, Bridge → Nexus → DE (Nexus handles DE routing)

---

### For DE (Distributed Elections)

**Your role**: Route LLM requests, select optimal models, execute universal tasks

**How you use Nexus**:
- **Receive Tier 2 escalations**: Nexus sends complex requests requiring deep reasoning
  - Example: "Analyze email thread, determine if contract needs legal review"
  - Example: "Prioritize project A vs project B given resource constraints"
- **Return structured responses**: Nexus expects specific format for grading/learning

**Integration pattern**:
```typescript
// Nexus escalates to DE
async function escalateToDE(request: Tier2Request) {
  const response = await fetch('https://de.solamp.workers.dev/api/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'email_analysis',
      prompt: `Analyze email thread:
        From: ${email.from}
        Subject: ${email.subject}
        Body: ${email.body}
        Context: ${mnemoContext}
        Question: Does this require legal review?`,
      priority: 'high',
      requester: 'nexus'
    })
  });

  const result = await response.json();

  // Nexus grades response
  const grade = gradeResponse(result);
  await reportGradeToDe(grade); // DE learns from grading

  return result;
}
```

**Key considerations**:
- DE doesn't decide *what* to do, just *how* to do it (model selection, prompt optimization)
- Nexus owns the reasoning: "Should I do X or Y?" → Nexus decides
- DE owns the execution: "Use Claude Opus with prompt template Z" → DE decides
- Return responses in structured format for grading

---

### For Mnemo (Short-Term Memory)

**Your role**: Provide 1M token context cache, fast queries

**How you use Nexus**:
- **Receive context loads**: Nexus decides what to load into your caches
  - Example: Phone call with Doug → Nexus loads Doug's emails, CRM, notes
  - Example: Marketing email → Nexus skips loading (not worth short-term memory)
- **Answer queries**: Nexus queries you for contextual information
  - Example: "What did Doug say about pricing in past emails?"

**Integration pattern**:
```typescript
// Nexus loads context into Mnemo
async function handleIncomingCall(callerId: string) {
  // Fetch relevant data from D1
  const emails = await db.prepare(
    'SELECT * FROM inbox_items WHERE source_id = ? ORDER BY captured_at DESC LIMIT 50'
  ).bind(callerId).all();

  const meetings = await db.prepare(
    'SELECT * FROM meeting_notes WHERE attendees LIKE ? ORDER BY date DESC LIMIT 10'
  ).bind(`%${callerId}%`).all();

  // Load into Mnemo
  await mnemo.load({
    sources: [
      { type: 'emails', data: emails },
      { type: 'meetings', data: meetings }
    ],
    alias: `call-context-${callerId}`,
    ttl: 3600 // 1 hour
  });

  // Query Mnemo during call
  const insight = await mnemo.query(`call-context-${callerId}`,
    'What are the key topics Doug cares about?'
  );

  // Display to user in real-time via Bridge
  return insight;
}
```

**Key considerations**:
- Nexus decides **what** to load (not everything goes into Mnemo)
- Nexus decides **when** to load (proactive: call starts, reactive: email arrives)
- Nexus decides **when to evict** (call ends, project context changes)
- Pattern learning: Track what context was actually useful → optimize loading

---

### For Email/Calendar Services (Gmail, Outlook, Zoom)

**Your role**: External data sources

**How Nexus uses you**:
- **Email ingestion**:
  - MVP: POP3/forwarding → Worker endpoint
  - Stage 2: OAuth + Gmail API polling
  - Stage 3: Multi-account support
  - Final: Cloudflare Email Routing (native)
- **Calendar sync**:
  - OAuth + Google Calendar API / Outlook API
  - Real-time webhook updates where possible
- **Meeting transcriptions**:
  - Zoom API for recordings + transcriptions
  - Telnyx for phone call transcriptions

**Integration pattern (Gmail)**:
```typescript
// Gmail OAuth flow (multi-account)
async function connectGmailAccount(userId: string, authCode: string) {
  // Exchange code for tokens
  const tokens = await exchangeOAuthCode(authCode);

  // Store in user_accounts table (encrypted)
  await db.prepare(`
    INSERT INTO user_accounts (id, user_id, provider, account_email, access_token, refresh_token)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(),
    userId,
    'google',
    tokens.email,
    await encrypt(tokens.access_token),
    await encrypt(tokens.refresh_token)
  ).run();
}

// Fetch emails from all accounts
async function fetchAllEmails(userId: string) {
  const accounts = await db.prepare(
    'SELECT * FROM user_accounts WHERE user_id = ? AND provider = ?'
  ).bind(userId, 'google').all();

  for (const account of accounts) {
    await refreshTokenIfNeeded(account.id);
    const emails = await fetchGmailEmails(account.access_token);
    await processEmails(emails); // Tier 1 classification
  }
}
```

**Key considerations**:
- Multi-account support from day 1 (work + personal Gmail)
- Incremental sync (don't reload everything)
- Token refresh handled by Nexus
- Real-time webhooks where possible (Gmail push notifications, Zoom webhooks)

---

## Current Status (as of 2025-12-05)

### ✅ Completed (v0.1 - Foundation)

- **Full CRUD API** for all entities (tasks, projects, inbox, ideas, people, commitments)
- **App-layer encryption** (AES-256-GCM) for sensitive fields
- **Zod validation** on all inputs
- **Custom error classes** (AppError, ValidationError, NotFoundError)
- **4 Durable Objects**:
  - `InboxManager`: Real-time capture & AI classification
  - `CaptureBuffer`: Voice/text buffering with rate limiting
  - `SyncManager`: Cross-device sync with conflict resolution
  - `UserSession`: Multi-device session management
- **Recurring tasks**: RRULE support with cron scheduling (daily at midnight UTC)
- **AI classification**: Claude API (MVP, to be replaced with CF Workers AI)
- **Test suite**: 97 passing tests
- **Deployment**: https://nexus.solamp.workers.dev (production)

### 🚧 In Progress (v0.2 - Tier 1/2 Evolution)

- **Replace Claude API** → CF Workers AI for Tier 1 (DeepSeek or similar)
- **DE integration**: Escalation pipeline for Tier 2 requests
- **Response grading**: Score DE responses for learning

### 📋 Roadmap

**v0.3 - Gmail Integration** (Major Branch):
- OAuth multi-account setup
- Email ingestion (MVP: forwarding, Final: Gmail API)
- Gmail-specific Tier 1 rules (marketing, receipts, invoices)
- Drive integration (file loading for context)
- Calendar sync (real-time webhook)
- Contacts sync
- Review all Google services before implementation

**v0.4 - Microsoft Integration** (Major Branch):
- Outlook/Exchange multi-account
- OneDrive integration
- Calendar and Contacts sync
- Xbox integration (if applicable)
- Review all Microsoft 365 services

**v0.5 - Zoom Integration** (Major Branch):
- Zoom Team Chat (replaces Slack)
- Meeting recordings and transcriptions
- Phone system integration (Telnyx)
- Real-time message sync
- Review all Zoom Workplace services

**v0.6 - Context Management Evolution**:
- Pattern learning: What context is actually used?
- Automatic Mnemo loading based on user activity
- Multi-tier memory strategy (HOT/WARM/COLD)
- Cross-session context ("last time we worked on X...")

**v0.7 - Autonomous Agent Integration**:
- Task delegation to agent swarms
- Agent status monitoring
- Result validation and integration

**Backburner** (Not Priority):
- Slack export
- Obsidian vault
- Otter/Fireflies transcripts (Zoom handles this)

---

## Technical Details

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    BRIDGE (UI Layer)                         │
│  • Web app (Qwik)                                            │
│  • Mobile app                                                │
│  • System tray                                               │
│  • Local file access                                         │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                 NEXUS (The Brain)                            │
│  • Strategic reasoning                                       │
│  • Communication management (email, text, calls)             │
│  • Time management (calendar, scheduling)                    │
│  • Project/task orchestration                                │
│  • Tier 1 classification (CF Workers AI)                     │
│  • Context management (what goes to Mnemo)                   │
│  • Long-term memory (D1)                                     │
└──────────┬───────────────────────┬──────────────────────────┘
           │                       │
           ▼                       ▼
┌──────────────────┐    ┌──────────────────────────┐
│   MNEMO          │    │    DE                    │
│   (Working Mem)  │    │    (Executor)            │
│  • 1M token ctx  │    │  • LLM routing           │
│  • Fast query    │    │  • Model selection       │
│  • TTL cache     │    │  • Prompt optimization   │
└──────────────────┘    └──────────────────────────┘
```

### Infrastructure

| Component | Technology |
|-----------|------------|
| Runtime | Cloudflare Workers |
| Framework | Hono |
| Database | D1 (SQLite) with app-layer encryption (AES-256-GCM) |
| State | Durable Objects (InboxManager, CaptureBuffer, SyncManager, UserSession) |
| Storage | R2 (for file attachments, future) |
| KV | Rate limiting, session caching |
| Auth | Dev JWT (MVP), OAuth via `workers-oauth-provider` (roadmap) |
| LLM (Tier 1) | Claude API (MVP), CF Workers AI (roadmap) |
| LLM (Tier 2) | DE (routes to Gemini, Claude, DeepSeek, etc.) |
| Package Manager | Bun (NOT npm) |
| Deployment | Cloudflare Workers (serverless) |

### API Endpoints

**Production**: `https://nexus.solamp.workers.dev`

| Endpoint | Methods | Description |
|----------|---------|-------------|
| `/api/tasks` | GET, POST, PATCH, DELETE | Task management |
| `/api/projects` | GET, POST, PATCH, DELETE | Project management |
| `/api/inbox` | GET, POST, PATCH, DELETE | Inbox items |
| `/api/ideas` | GET, POST, PATCH, DELETE | Ideas/someday-maybe |
| `/api/people` | GET, POST, PATCH, DELETE | Contacts |
| `/api/commitments` | GET, POST, PATCH, DELETE | Waiting-for/owed-to |
| `/api/capture` | POST | Capture with AI classification |
| `/api/capture/batch` | POST | Batch capture |
| `/api/capture/status` | GET | InboxManager status |
| `/api/capture/queue` | GET | Classification queue |
| `/api/capture/ws` | WebSocket | Real-time updates |
| `/api/auth/session` | POST, GET, DELETE | Session management |
| `/api/sync/*` | Various | Cross-device sync |
| `/api/buffer/*` | Various | Voice/text buffering |
| `/setup` | POST | Dev-only: create tenant/user |

### Performance Characteristics

| Metric | Value |
|--------|-------|
| Tier 1 classification | <2s (CF Workers AI target) |
| Tier 1 cost | <$0.01 per request (target) |
| Tier 2 escalation rate | 20-30% (target: 80% handled by Tier 1) |
| Database queries | <100ms (D1 with indexes) |
| WebSocket latency | <500ms (Durable Objects) |
| Concurrent sessions | 10 per user (UserSession DO) |
| Session TTL | 7 days (configurable to 30) |
| Sync conflict resolution | Last-write-wins (timestamp-based) |

---

## Integration Checklist

When integrating your service with Nexus:

### Before Development

- [ ] Read `/home/chris/nexus/CLAUDE.md` (project instructions)
- [ ] Review `/home/chris/nexus/docs/TEAM-LEADER-SUMMARY.md` (this document)
- [ ] Review `/home/chris/nexus/ROADMAP.md` (understand vision)
- [ ] Check existing API routes in `src/routes/`
- [ ] Understand Durable Objects in `src/durable-objects/`

### During Development

- [ ] Use D1 for all persistent storage (see schema.sql)
- [ ] Encrypt sensitive fields with `lib/encryption.ts` (see CLAUDE.md for list)
- [ ] Use Zod for validation (`lib/validation.ts`)
- [ ] Add custom error classes (`lib/errors.ts`)
- [ ] Follow tenant-scoping pattern (every query includes `tenant_id`)
- [ ] Add unit tests (Vitest)
- [ ] Document API endpoints with JSDoc

### Integration Points

- [ ] **If you're Bridge**: Call Nexus API directly, handle real-time WebSocket
- [ ] **If you're DE**: Receive escalations from Nexus, return structured responses
- [ ] **If you're Mnemo**: Receive context loads, answer queries from Nexus
- [ ] **If you're an external service**: Provide OAuth + API access to Nexus

### Authentication

- [ ] **Dev mode**: Use dev JWT (see `lib/auth.ts`)
- [ ] **Production** (roadmap): OAuth via `workers-oauth-provider`
- [ ] Store tokens securely (Cloudflare Secrets, encrypted in D1)

### Error Handling

- [ ] Handle `AppError`, `ValidationError`, `NotFoundError` from Nexus
- [ ] Retry logic for transient failures
- [ ] Log errors but don't expose internals to client
- [ ] Return proper HTTP status codes (400, 401, 404, 500)

---

## Open Questions / TBD

These questions require cross-team discussion:

1. **Tier 1 → Tier 2 Handoff**: What's the contract between Nexus and DE?
   - Structured prompt format?
   - Response schema?
   - Grading criteria?

2. **Mnemo Loading Strategy**: How aggressive should Nexus be with context loading?
   - Load everything proactively (high cost, fast queries)?
   - Load on-demand (low cost, slower queries)?
   - Hybrid with pattern learning?

3. **Multi-Tenant Support**: Nexus has tenant architecture but single-user for now.
   - When do we enable multi-user per tenant?
   - Shared projects/tasks?
   - Permission model?

4. **Bridge ↔ Nexus Auth**: How does Bridge authenticate to Nexus?
   - JWT with refresh tokens?
   - Session cookies?
   - OAuth?

5. **Email Routing**: What's the final email ingestion method?
   - Cloudflare Email Routing (native)?
   - Gmail API polling?
   - Hybrid (forwarding for MVP, API for production)?

6. **Autonomous Agents**: How do agents interact with Nexus?
   - Agents call Nexus API to update task status?
   - Nexus monitors agents via separate API?
   - WebSocket for real-time agent → Nexus updates?

7. **Cost Tracking**: How do we attribute costs across services?
   - Nexus tracks Tier 1 costs
   - DE tracks Tier 2 costs
   - Mnemo tracks context costs
   - Unified billing dashboard?

---

## Key Contacts

| Role | Contact | Repository |
|------|---------|------------|
| **Nexus Lead** | (your team) | github.com/CyberBrown/nexus |
| **DE Lead** | TBD | TBD |
| **Mnemo Lead** | TBD | github.com/[org]/mnemo |
| **Bridge Lead** | TBD | TBD |

---

## Quick Start for Integration

### 1. Example: Bridge Fetches Tasks

```typescript
import { NexusClient } from '@nexus/client';

const client = new NexusClient({
  endpoint: 'https://nexus.solamp.workers.dev',
  auth: { bearer: userToken }
});

// Fetch today's tasks
const tasks = await client.tasks.list({ status: 'today' });

// Create new task
const newTask = await client.tasks.create({
  title: 'Pick up milk',
  due_date: '2025-12-05',
  status: 'inbox'
});

// WebSocket for real-time updates
const ws = client.inbox.subscribe((update) => {
  console.log('New inbox item:', update);
});
```

### 2. Example: Nexus Escalates to DE

```typescript
// Nexus sends complex request to DE
async function escalateToDE(email: Email, context: string) {
  const response = await fetch('https://de.solamp.workers.dev/api/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'email_analysis',
      prompt: `Analyze this email and determine priority:
        From: ${email.from}
        Subject: ${email.subject}
        Body: ${email.body}
        Context: ${context}`,
      priority: 'high',
      requester: 'nexus',
      expected_format: {
        priority: 'number (1-3)',
        action: 'string (auto-execute | notify | escalate)',
        reasoning: 'string'
      }
    })
  });

  const result = await response.json();

  // Grade response for DE learning
  const grade = gradeResponse(result, email);
  await reportGradeToDe(grade);

  return result;
}
```

### 3. Example: Nexus Loads Context into Mnemo

```bash
# Via MCP (if Mnemo exposes MCP)
curl -X POST https://mnemo.solamp.workers.dev/tools/context_load \
  -H "Authorization: Bearer $MNEMO_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sources": [
      { "type": "emails", "data": [...] },
      { "type": "meetings", "data": [...] }
    ],
    "alias": "client-doug-context",
    "ttl": 3600
  }'

# Query context
curl -X POST https://mnemo.solamp.workers.dev/tools/context_query \
  -H "Authorization: Bearer $MNEMO_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "alias": "client-doug-context",
    "query": "What are Doug'\''s key concerns about pricing?"
  }'
```

---

## Resources

- **Repository**: https://github.com/CyberBrown/nexus
- **Production**: https://nexus.solamp.workers.dev
- **Documentation**:
  - `/home/chris/nexus/CLAUDE.md` (project instructions)
  - `/home/chris/nexus/ROADMAP.md` (vision and roadmap)
  - `/home/chris/nexus/docs/TEAM-LEADER-SUMMARY.md` (this document)
  - `/home/chris/nexus/docs/features/` (feature-specific docs)
- **Tests**: `bun test` (97 passing tests)
- **Developer Guides**: Use MCP server `mcp__developer-guides__*` tools

---

## Summary

**Nexus is the brain of the ecosystem.**

- Gathers communication (email, text, calls, meetings)
- Manages time (calendar, scheduling, conflicts)
- Orchestrates projects/tasks (strategy, priorities, delegation)
- Decides context management (what goes to Mnemo, what stays in D1)
- Owns Tier 1 processing (fast classification, 80% of requests)
- Escalates to DE for Tier 2 (complex reasoning, 20% of requests)
- Learns from patterns (user preferences, recurring decisions)
- Delegates to autonomous agents (build feature X, analyze dataset Y)

**When to use Nexus**:
- ✅ Need to process email, calendar, or task data
- ✅ Want to capture ideas, goals, or commitments
- ✅ Implementing communication/time management features
- ✅ Need user-specific context and preferences
- ✅ Building features that require long-term memory

**When NOT to use Nexus**:
- ❌ UI rendering (use Bridge)
- ❌ LLM model selection (use DE)
- ❌ Short-term context caching (use Mnemo)
- ❌ Universal task execution (use DE)

---

**Questions?** Contact the Nexus team or refer to the documentation in `/home/chris/nexus/`.
