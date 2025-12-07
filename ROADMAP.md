# Nexus Roadmap

## Vision: The Strategic Reasoning Layer

Nexus is evolving from a basic inbox/task manager into an autonomous strategic organizer that processes hundreds of daily communications, manages 10-20 projects, synthesizes 50+ goals, and surfaces the right information at the right time with minimal human intervention.

**Nexus is "the brain"** - it gathers, sorts, contextualizes, and makes high-level decisions. It owns Tier 1 processing (fast classification), delegates complex reasoning to DE (Tier 2), and manages the boundary between short-term memory (Mnemo) and long-term storage (D1).

```
┌─────────────────────────────────────────────────────────────────────┐
│                      DATA SOURCES (Inputs)                           │
│   Email  Texts  Calendar  Calls  Meetings  Files  Ideas  Goals      │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                 NEXUS: TIER 1 — TRIAGE (Fast/Cheap)                  │
│                                                                      │
│   • Rules-based classification                                       │
│   • Light LLM (CF Workers AI - DeepSeek)                             │
│   • Pattern matching (sender recognition, keywords)                  │
│                                                                      │
│   ACTIONS:                          ESCALATE TO TIER 2 (via DE):     │
│   • Marketing → Unsubscribe         • Invoices (needs review)        │
│   • Mom's recipe → Save to ideas    • Important client emails        │
│   • Spam → Delete                   • Calendar conflicts             │
│   • Receipt → File                  • Strategic decisions            │
│   • Simple task → Create            • Pattern synthesis              │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│            NEXUS: TIER 2 ORCHESTRATION (via DE)                      │
│                                                                      │
│   • Craft precise prompts for DE                                     │
│   • Load context from Mnemo (past interactions, patterns)            │
│   • Receive structured responses                                     │
│   • Grade responses → improve DE over time                           │
│                                                                      │
│   OUTCOMES:                                                          │
│   ┌─────────────────┬─────────────────┬─────────────────────────┐   │
│   │ AUTO-EXECUTE    │ NOTIFY USER     │ NEEDS ATTENTION         │   │
│   ├─────────────────┼─────────────────┼─────────────────────────┤   │
│   │ Gas bill normal │ Hourly recap:   │ Priority 3:             │   │
│   │ → Schedule pay  │ "Added lunch    │ "Solamp invoice past    │   │
│   │                 │  to calendar"   │  due - needs input"     │   │
│   │ Recipe from mom │                 │                         │   │
│   │ → Save to ideas │ Daily recap:    │ Priority 1:             │   │
│   │                 │ "Mom sent       │ [Reserved for urgent]   │   │
│   │                 │  recipe"        │                         │   │
│   └─────────────────┴─────────────────┴─────────────────────────┘   │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      CONTEXT MANAGEMENT                              │
│                                                                      │
│   MNEMO (Short-Term):          D1 (Long-Term):                       │
│   • Active projects            • Full email history                  │
│   • Current conversations      • All tasks/projects                  │
│   • Today's calendar           • Ideas backlog                       │
│   • Client context (call)      • User preferences                    │
│                                • Pattern library                     │
│                                                                      │
│   Nexus decides: What's HOT (Mnemo) vs COLD (D1)                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Current: v0.1 - Foundation Complete ✅

**Status**: Production-ready backend with full CRUD API

### Completed Features

- ✅ **CRUD API**: Tasks, projects, inbox, ideas, people, commitments
- ✅ **App-layer encryption**: AES-256-GCM for sensitive fields
- ✅ **Zod validation**: All inputs validated
- ✅ **Custom error classes**: AppError, ValidationError, NotFoundError
- ✅ **4 Durable Objects**:
  - `InboxManager`: Real-time capture & AI classification
  - `CaptureBuffer`: Voice/text buffering with rate limiting (300/min)
  - `SyncManager`: Cross-device sync with last-write-wins
  - `UserSession`: Multi-device session management (max 10, 7-day TTL)
- ✅ **Recurring tasks**: RRULE support with cron scheduling (daily midnight UTC)
- ✅ **AI classification**: Claude API (MVP hack, to be replaced)
- ✅ **Test suite**: 97 passing tests
- ✅ **Deployment**: https://nexus.solamp.workers.dev (production)

### Current Tier 1 Implementation

- Claude API direct calls (MVP hack)
- Auto-creates tasks when confidence ≥80%
- Processes inbox items via InboxManager DO

---

## v0.2 - Tier 1/2 Evolution 🚧

**Goal**: Replace Claude API with CF Workers AI for Tier 1, integrate DE for Tier 2

### Phase 1: Own Tier 1 (Light LLM)

**Why**: Cost optimization (80% of requests handled cheaply)

**Implementation**:
- Deploy **DeepSeek** or similar on **Cloudflare Workers AI**
- Keep existing InboxManager DO logic
- Replace Claude API calls with CF Workers AI calls
- Target: <$0.01 per request, <2s response time

**Tier 1 Capabilities**:
- Rules-based classification (regex, heuristics)
- Light ML (spam detection, sender recognition)
- Pattern matching (marketing keywords, receipt patterns)
- Simple task creation (≥80% confidence)

**When to escalate to Tier 2**:
- Requires semantic understanding beyond keywords
- Needs historical context (past interactions)
- Involves decision-making (calendar conflicts, prioritization)
- Matches escalation rules (invoices, important clients)

### Phase 2: DE Integration (Tier 2 Escalation)

**Why**: Delegate complex reasoning to DE's LLM routing

**Implementation**:
```typescript
// Nexus escalates complex request to DE
async function escalateToDE(request: Tier2Request) {
  // 1. Load context from Mnemo
  const context = await loadContextFromMnemo(request);

  // 2. Craft precise prompt
  const prompt = craftPrompt(request, context);

  // 3. Send to DE
  const response = await fetch('https://de.solamp.workers.dev/api/request', {
    method: 'POST',
    body: JSON.stringify({
      type: request.type,
      prompt: prompt,
      priority: request.priority,
      requester: 'nexus',
      expected_format: {
        action: 'auto-execute | notify | escalate',
        priority: 1 | 2 | 3,
        reasoning: 'string'
      }
    })
  });

  // 4. Grade response
  const result = await response.json();
  const grade = gradeResponse(result, request);
  await reportGradeToDe(grade); // DE learns

  return result;
}
```

**Grading Criteria**:
- Response matches expected format ✅ / ❌
- Action was correct (validated by user feedback) ✅ / ❌
- Reasoning was clear ✅ / ❌
- Response time was acceptable ✅ / ❌

### Deliverables

- [ ] Replace Claude API with CF Workers AI (Tier 1)
- [ ] Implement DE escalation pipeline
- [ ] Add response grading logic
- [ ] Update tests for Tier 1/2 split
- [ ] Document escalation rules
- [ ] Benchmark: 80% Tier 1, 20% Tier 2

---

## v0.3 - Gmail Integration (Major Branch) 📧

**Goal**: Multi-account Gmail integration with real-time processing

### Why This Is a Major Branch

Gmail integration touches:
- Email (core communication)
- Drive (file context for projects)
- Calendar (time management)
- Contacts (people database)
- All other Google Workspace services (Docs, Sheets, etc.)

This requires:
- OAuth 2.0 flow
- Multi-account support (work + personal)
- Incremental sync (don't reload everything)
- Real-time webhooks (Gmail push notifications)
- Comprehensive service review before implementation

### Phase 1: Email Ingestion (MVP)

**Goal**: Get emails flowing into Nexus for Tier 1 processing

**Options**:
1. **POP3/IMAP** (quickest MVP)
   - Simple email forwarding
   - Cron job every 5 minutes
   - No OAuth required
   - ❌ Not real-time, less secure

2. **Gmail API + polling** (better)
   - OAuth 2.0 for user consent
   - Poll every 1-2 minutes
   - Incremental sync via `historyId`
   - ✅ Secure, reliable

3. **Cloudflare Email Routing** (native)
   - Email → Worker directly
   - Real-time processing
   - No polling required
   - ✅ Best performance, Cloudflare-native

**Decision**: Start with **POP3/forwarding** for MVP, migrate to **Gmail API** for Stage 2, consider **CF Email Routing** for final.

**Implementation (MVP)**:
```typescript
// Scheduled job: fetch emails every 5 minutes
export async function scheduled(event: ScheduledEvent, env: Env) {
  const accounts = await fetchEmailAccounts(env.DB);

  for (const account of accounts) {
    const emails = await fetchPOP3Emails(account);

    for (const email of emails) {
      // Send to InboxManager for Tier 1 processing
      const stub = env.INBOX_MANAGER.get(
        env.INBOX_MANAGER.idFromName(account.user_id)
      );
      await stub.capture({
        raw_content: email.body,
        source_type: 'email',
        source_id: email.messageId,
        source_platform: 'gmail',
        metadata: {
          from: email.from,
          subject: email.subject,
          date: email.date
        }
      });
    }
  }
}
```

### Phase 2: OAuth Multi-Account

**Goal**: Support multiple Gmail accounts per user (work + personal)

**Database schema** (already exists in `schema.sql`):
```sql
CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,  -- 'google'
  integration_type TEXT NOT NULL,  -- 'gmail', 'drive', 'calendar'
  access_token TEXT,  -- Encrypted
  refresh_token TEXT,  -- Encrypted
  token_expires_at TEXT,
  account_email TEXT,
  account_name TEXT,
  account_id TEXT,
  last_sync_at TEXT,
  sync_cursor TEXT,  -- historyId for incremental sync
  sync_status TEXT DEFAULT 'active',
  sync_error TEXT,
  settings TEXT,  -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  UNIQUE(tenant_id, user_id, provider, integration_type, account_id)
);
```

**OAuth flow**:
1. User clicks "Connect Gmail" in Bridge
2. Bridge → Nexus `/api/integrations/google/oauth/start`
3. Nexus generates OAuth URL (via `workers-oauth-provider`)
4. User consents in Google
5. Google redirects to `/api/integrations/google/oauth/callback`
6. Nexus exchanges code for tokens, stores encrypted in `integrations` table
7. Start sync job for this account

**Multi-account handling**:
```typescript
// Fetch emails from ALL user's Gmail accounts
async function syncAllGmailAccounts(userId: string) {
  const accounts = await db.prepare(`
    SELECT * FROM integrations
    WHERE user_id = ? AND provider = 'google' AND integration_type = 'gmail'
  `).bind(userId).all();

  for (const account of accounts) {
    await refreshTokenIfNeeded(account);
    await syncGmailAccount(account);
  }
}
```

### Phase 3: Incremental Sync

**Goal**: Don't reload all emails every time

**Gmail API approach**:
- Use `historyId` to fetch only new/modified emails since last sync
- Store `historyId` in `integrations.sync_cursor`
- On first sync, fetch last 30 days (configurable)
- On subsequent syncs, use `history.list()` API

```typescript
async function syncGmailAccount(account: Integration) {
  const gmail = google.gmail({ version: 'v1', auth: account.access_token });

  if (!account.sync_cursor) {
    // First sync: fetch last 30 days
    const response = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 500,
      q: `after:${Date.now() - 30 * 24 * 60 * 60 * 1000}`
    });
    // Process emails...
    await updateSyncCursor(account.id, response.historyId);
  } else {
    // Incremental sync: use historyId
    const history = await gmail.users.history.list({
      userId: 'me',
      startHistoryId: account.sync_cursor
    });
    // Process only new/modified emails...
    await updateSyncCursor(account.id, history.historyId);
  }
}
```

### Phase 4: Real-Time Webhooks

**Goal**: Receive emails instantly via Gmail push notifications

**Gmail Pub/Sub approach**:
1. Create Google Cloud Pub/Sub topic
2. Subscribe to Gmail push notifications: `gmail.users.watch()`
3. Receive notifications at Worker endpoint: `/api/integrations/google/webhook`
4. Fetch new emails immediately

```typescript
// Webhook endpoint
app.post('/api/integrations/google/webhook', async (c) => {
  const notification = await c.req.json();
  const { emailAddress, historyId } = notification.message.data;

  // Find account
  const account = await findIntegrationByEmail(emailAddress);

  // Sync immediately
  await syncGmailAccount(account);

  return c.json({ success: true });
});
```

### Phase 5: Drive Integration

**Goal**: Load files into Mnemo for project context

**Use cases**:
- User mentions "Project X proposal" → Load from Drive into Mnemo
- Meeting scheduled → Load agenda doc from Drive
- Client email references doc → Load for context

**Implementation**:
```typescript
// Load Drive file into Mnemo
async function loadDriveFileToMnemo(fileId: string, account: Integration) {
  const drive = google.drive({ version: 'v3', auth: account.access_token });
  const file = await drive.files.get({ fileId, alt: 'media' });

  // Send to Mnemo
  await mnemo.load({
    sources: [{ type: 'google-drive', fileId, content: file.data }],
    alias: `drive-${fileId}`,
    ttl: 3600 // 1 hour
  });
}
```

### Phase 6: Calendar & Contacts Sync

**Goal**: Full time management and people database

**Calendar**:
- Sync events from all accounts
- Detect conflicts
- Suggest resolutions (client dinner vs gym → learn patterns)

**Contacts**:
- Sync to `people` table
- Link to email `from` addresses
- CRM-style profile (last interaction, preferences)

### Deliverables

- [ ] **Phase 1**: POP3/forwarding email ingestion (MVP)
- [ ] **Phase 2**: OAuth multi-account setup
- [ ] **Phase 3**: Incremental sync via `historyId`
- [ ] **Phase 4**: Real-time webhooks (Gmail Pub/Sub)
- [ ] **Phase 5**: Drive file loading to Mnemo
- [ ] **Phase 6**: Calendar and Contacts sync
- [ ] **Documentation**: OAuth flow, multi-account architecture
- [ ] **Review**: All Google Workspace services before finalizing

---

## v0.4 - Microsoft Integration (Major Branch) 📧

**Goal**: Multi-account Microsoft 365 integration (Outlook, OneDrive, Calendar, Contacts)

### Scope

Similar to Gmail integration, but for Microsoft ecosystem:
- **Outlook/Exchange**: Email (multi-account)
- **OneDrive**: File storage
- **Calendar**: Events, scheduling
- **Contacts**: People database
- **Xbox**: (if applicable - gaming profiles, social)
- **All Microsoft 365 services**: Review before implementation

### Key Differences from Google

- OAuth via Microsoft Identity Platform
- Graph API (unified API for all Microsoft services)
- Handle enterprise vs personal account differences
- Support both Microsoft 365 and legacy Exchange

### Deliverables

- [ ] OAuth 2.0 flow for Microsoft
- [ ] Outlook email ingestion (multi-account)
- [ ] OneDrive file loading
- [ ] Calendar and Contacts sync
- [ ] Incremental sync via `deltaLink`
- [ ] Real-time webhooks (Graph API subscriptions)
- [ ] Documentation: OAuth flow, Graph API integration
- [ ] Review: All Microsoft 365 services

---

## v0.5 - Zoom Integration (Major Branch) 💬

**Goal**: Team communication and phone system integration

### Scope

Zoom is the primary team communication platform, replacing Slack:
- **Zoom Team Chat**: Messages, channels, DMs
- **Meeting recordings**: Video and audio
- **Transcriptions**: Meeting notes, AI summaries
- **Cloud recordings**: File storage
- **Phone system**: Via Telnyx integration

### Why Zoom?

- Used for team chat (replaces Slack)
- All meeting notes and transcriptions in one place
- Phone system integration (Telnyx numbers)
- Zoom Workplace = all-in-one collaboration suite

### Implementation

**Zoom Team Chat**:
- OAuth + Zoom API
- Real-time message sync via webhooks
- Store messages in D1
- Load into Mnemo for active conversations

**Meeting Recordings**:
- Fetch recordings via Zoom API
- Store metadata in D1, files in R2
- Transcriptions → load into Mnemo for context

**Phone System** (Telnyx):
- Telnyx API for phone numbers
- Transcribe calls (Telnyx or Zoom)
- Store transcriptions in D1
- Real-time transcription during calls → load into Mnemo

### Deliverables

- [ ] Zoom OAuth + Team Chat sync
- [ ] Meeting recordings and transcriptions
- [ ] Phone system integration (Telnyx)
- [ ] Real-time message webhooks
- [ ] Transcription indexing and search
- [ ] Documentation: Zoom Workplace integration
- [ ] Review: All Zoom services before finalizing

---

## v0.6 - Context Management Evolution 🧠

**Goal**: Smart context loading/eviction based on learned patterns

### Current State

- Manual context decisions (hardcoded rules)
- Nexus decides what goes to Mnemo, but rules are static

### Future State

- **Pattern learning**: Track which context was actually useful
- **Proactive loading**: Predict what user needs before they ask
- **Relevance scoring**: HOT (Mnemo) vs WARM (compressed) vs COLD (D1)
- **Automatic eviction**: Remove unused context from Mnemo

### Key Concepts

**Session Awareness**:
- Detect current project/task from conversation flow
- Understand working context ("I'm debugging auth module")
- Track topic transitions

**Proactive Loading**:
- Phone call with Doug → Load Doug's emails, CRM profile, meeting notes
- User opens Project X → Load X's files, tasks, recent updates
- Calendar event starts → Load agenda, attendee context

**Relevance Scoring**:
- Recently queried = high relevance
- Mentioned in conversation = boosted
- Time decay for unused context

**Memory Tiers** (Nexus ↔ Mnemo):
```
┌─────────────────────────────────────┐
│  HOT (Mnemo)                        │
│  Active working context             │
│  Full fidelity, instant query       │
│  ~500k-900k tokens                  │
│  - Current project files            │
│  - Active email threads             │
│  - Today's calendar                 │
│  - Client context (ongoing call)    │
├─────────────────────────────────────┤
│  WARM (Compressed in D1)            │
│  Recently used, summarized          │
│  Key facts + structure preserved    │
│  Can be re-expanded to HOT          │
│  - Last week's emails (summary)     │
│  - Recent project updates           │
├─────────────────────────────────────┤
│  COLD (D1 Long-Term)                │
│  Historical context                 │
│  Full data, indexed                 │
│  Requires explicit retrieval        │
│  - Full email history               │
│  - All tasks/projects               │
│  - Ideas backlog                    │
└─────────────────────────────────────┘
```

**Automatic Lifecycle**:
- New context → HOT (Mnemo)
- Unused for N queries → compress to WARM
- Unused for N hours → demote to COLD
- Re-referenced → promote back up

### Example: Client Call Scenario

```typescript
// User starts call with Doug
async function onCallStart(callerId: string) {
  // 1. Identify caller
  const person = await db.prepare(
    'SELECT * FROM people WHERE phone = ?'
  ).bind(callerId).first();

  // 2. Fetch relevant context from COLD (D1)
  const emails = await db.prepare(
    'SELECT * FROM inbox_items WHERE source_id = ? ORDER BY captured_at DESC LIMIT 50'
  ).bind(person.email).all();

  const meetings = await db.prepare(
    'SELECT * FROM meeting_notes WHERE attendees LIKE ? ORDER BY date DESC LIMIT 10'
  ).bind(`%${person.email}%`).all();

  const crmData = await fetchCRMProfile(person.id);

  // 3. Load into HOT (Mnemo)
  await mnemo.load({
    sources: [
      { type: 'emails', data: emails },
      { type: 'meetings', data: meetings },
      { type: 'crm', data: crmData }
    ],
    alias: `call-context-${callerId}`,
    ttl: 3600 // 1 hour
  });

  // 4. Query during call for real-time insights
  const insights = await mnemo.query(`call-context-${callerId}`, `
    - What are Doug's key concerns?
    - What did we discuss last time?
    - Any pending action items?
  `);

  // 5. Display to user via Bridge
  await bridge.displayInsights(insights);
}

// Call ends
async function onCallEnd(callerId: string) {
  // Track: Was this context useful?
  const usage = await mnemo.getUsageStats(`call-context-${callerId}`);

  if (usage.queries > 0) {
    // Context was useful, keep pattern
    await logPatternSuccess('call-context-loading', callerId);
  } else {
    // Context was not used, adjust future loading
    await logPatternFailure('call-context-loading', callerId);
  }

  // Evict from HOT after 1 hour
  // (TTL handles this automatically)
}
```

### Deliverables

- [ ] Pattern learning: Track context usage
- [ ] Proactive loading based on user activity
- [ ] Relevance scoring algorithm
- [ ] Multi-tier memory strategy (HOT/WARM/COLD)
- [ ] Automatic compression and eviction
- [ ] Cross-session context ("last time we worked on X...")
- [ ] Documentation: Context management patterns

---

## v0.7 - Autonomous Agent Integration 🤖

**Goal**: Delegate tasks to autonomous agent swarms

### Use Case

User has idea: "Build dog translator app"

**Nexus workflow**:
1. Capture idea via `/api/ideas`
2. Analyze idea (Tier 1 → Tier 2 escalation)
3. Break down into tasks
4. Delegate to autonomous agent swarm
5. Monitor agent progress
6. Validate results
7. Integrate into project

### Architecture

```
User: "Build dog translator app"
  ↓
Nexus captures idea
  ↓
Nexus analyzes feasibility (via DE Tier 2)
  ↓
Nexus breaks down into tasks:
  - Research existing solutions
  - Design audio processing pipeline
  - Build ML model
  - Create mobile app
  - Test with dogs
  ↓
Nexus delegates to agent swarm
  ↓
Agents execute tasks, report progress
  ↓
Nexus validates results, integrates into project
  ↓
User reviews final output
```

### Implementation

**Task delegation**:
```typescript
// Nexus delegates task to agent swarm
async function delegateToAgents(task: Task) {
  // 1. Prepare task context
  const context = await loadTaskContext(task);

  // 2. Send to agent coordinator
  const response = await fetch('https://agent-swarm.solamp.workers.dev/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      task_id: task.id,
      title: task.title,
      description: task.description,
      context: context,
      deadline: task.due_date,
      priority: task.urgency
    })
  });

  // 3. Store agent assignment
  await db.prepare(`
    UPDATE tasks SET
      assigned_to = 'agent-swarm',
      status = 'in_progress'
    WHERE id = ?
  `).bind(task.id).run();

  return response;
}
```

**Agent progress monitoring**:
```typescript
// Webhook: agent reports progress
app.post('/api/agents/progress', async (c) => {
  const { task_id, progress, status, results } = await c.req.json();

  // Update task status
  await db.prepare(`
    UPDATE tasks SET
      status = ?,
      progress = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).bind(status, progress, task_id).run();

  // Notify user via Bridge
  await bridge.notifyUser({
    type: 'agent_progress',
    task_id,
    progress,
    message: `Agent swarm ${progress}% complete on "${task.title}"`
  });

  return c.json({ success: true });
});
```

**Result validation**:
```typescript
// Agent completes task
async function onAgentComplete(taskId: string, results: any) {
  // 1. Validate results (Tier 2 via DE)
  const validation = await validateAgentResults(results);

  if (validation.passed) {
    // 2. Integrate into project
    await integrateResults(taskId, results);

    // 3. Mark task complete
    await db.prepare(`
      UPDATE tasks SET
        status = 'completed',
        completed_at = datetime('now'),
        results = ?
      WHERE id = ?
    `).bind(JSON.stringify(results), taskId).run();

    // 4. Notify user
    await bridge.notifyUser({
      type: 'task_complete',
      task_id: taskId,
      message: 'Agent swarm completed task, results validated ✅'
    });
  } else {
    // 5. Escalate to user for review
    await escalateToUser(taskId, results, validation.issues);
  }
}
```

### Deliverables

- [ ] Agent swarm API integration
- [ ] Task delegation logic
- [ ] Progress monitoring via webhooks
- [ ] Result validation pipeline
- [ ] Integration workflow
- [ ] User escalation for edge cases
- [ ] Documentation: Agent integration patterns

---

## v0.8 - Production Auth 🔐

**Goal**: Replace dev JWT with production OAuth

### Current State

- Dev JWT tokens (hardcoded in `lib/auth.ts`)
- No real user authentication
- Single tenant, single user

### Future State

- OAuth 2.0 via `workers-oauth-provider`
- Support multiple identity providers (Google, Microsoft, GitHub)
- Multi-user per tenant
- Role-based access control (admin, member, viewer)

### Implementation

See existing plan: `/home/chris/nexus/docs/features/ProductionAuth-Plan.md`

**Key points**:
- Self-hosted JWT with `jose` library
- Multi-provider OAuth (Google, Microsoft, GitHub)
- Refresh tokens stored encrypted in D1
- Session management via UserSession DO

### Deliverables

- [ ] Implement `workers-oauth-provider` integration
- [ ] Multi-provider OAuth flow
- [ ] Refresh token management
- [ ] Role-based access control
- [ ] Session hijacking prevention
- [ ] Admin UI for user management
- [ ] Documentation: OAuth flow, security best practices

---

## Backburner (Not Priority)

These features are **not prioritized** and should be revisited later:

- ❌ **Slack export**: Zoom Team Chat replaces Slack
- ❌ **Obsidian vault**: Markdown knowledge base (low priority)
- ❌ **Otter/Fireflies transcripts**: Zoom handles meeting transcriptions
- ❌ **Email exports (mbox)**: Real-time sync via API preferred

---

## Future Explorations

**Multi-Tenant Expansion**:
- Support multiple users per tenant
- Shared projects and tasks
- Team collaboration features
- Permission model

**Voice-First Interaction**:
- Continuous voice capture (mobile)
- Real-time transcription and classification
- Voice commands ("Remind me to call Doug")
- Ambient computing (always listening, context-aware)

**Predictive Intelligence**:
- Predict user's next action based on patterns
- Proactive suggestions ("You usually call Doug on Fridays")
- Anomaly detection ("Doug hasn't emailed this week, unusual")

**Cross-Platform Sync**:
- Desktop app (Electron or Tauri)
- Mobile app (React Native or Flutter)
- Browser extension
- System tray integration

**Self-Improving System**:
- Track which Tier 1 decisions were correct (validated by user)
- Fine-tune LLM on user-specific patterns
- Learn escalation thresholds per user
- Adapt to changing priorities over time

---

## Success Metrics

| Metric | Target | Current |
|--------|--------|---------|
| **Tier 1 handling rate** | 80% | TBD (after v0.2) |
| **Tier 1 cost per request** | <$0.01 | ~$0.05 (Claude API) |
| **Tier 2 escalation rate** | 20% | TBD |
| **Response time (Tier 1)** | <2s | ~1.5s |
| **Context relevance** | 90% | TBD (after v0.6) |
| **User intervention rate** | <10% | TBD |
| **Agent task completion** | 80% | TBD (after v0.7) |

---

## Summary

**Nexus is evolving from a basic task manager into an autonomous strategic organizer.**

**Current state**: Foundation complete (v0.1)
**Next steps**: Tier 1/2 evolution (v0.2), Gmail integration (v0.3)
**Long-term vision**: Multi-platform, voice-first, self-improving system that handles 90% of communication/time management autonomously

**Key principles**:
- Nexus owns Tier 1 (fast, cheap classification)
- DE handles Tier 2 (complex reasoning)
- Mnemo provides working memory
- Bridge provides user interface
- Autonomous agents execute delegated tasks
- System learns from user patterns over time

---

**Questions?** Refer to `/home/chris/nexus/CLAUDE.md` for project instructions or `/home/chris/nexus/docs/TEAM-LEADER-SUMMARY.md` for ecosystem integration.
