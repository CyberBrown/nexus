<!-- Developer Guides MCP Setup v1.1.0 - Check for updates: docs/CLAUDE-MD-SETUP.md -->
<!-- Last execution test: 2025-12-21 -->
# CLAUDE.md - Nexus Project Instructions

## Project Overview

Nexus is **The Brain** of the AI infrastructure ecosystem - the orchestration layer that handles Tier 1 processing, memory management, and coordinates all other services.

### Ecosystem Role

| Pillar | Role |
|--------|------|
| **Nexus** (this) | The Brain - orchestration, Tier 1 processing, memory management |
| [Mnemo](https://github.com/Logos-Flux/mnemo) | Working Memory - context caching only (no decision-making) |
| [DE](https://github.com/CyberBrown/distributed-electrons) | Arms & Legs - Tier 2+ execution, LLM routing, media services |
| Bridge (future) | User Interface - voice, text, graphics, all user-facing |

### Nexus Core Responsibilities

**Tier 1 Processing:**
- Input triage and routing
- Decide when to escalate to Tier 2 (DE)
- Orchestrate LLM calls via DE service binding (never calls LLM providers directly)

**Active Memory Manager (AMM):**
- Entity detection in conversations
- Session awareness and context tracking
- Proactive context loading triggers
- Decides WHAT context Mnemo should load
- Manages memory tiers (HOT/WARM/COLD)

**Long-term Memory:**
- Persistent storage and retrieval
- Cross-session knowledge
- User preferences and patterns

**Orchestration:**
- Coordinates Mnemo (tells it what to load)
- Coordinates DE (sends Tier 2 requests)
- Input/output routing

**NOT Nexus's Job:**
- Voice/UI (that's Bridge)
- Context caching mechanics (that's Mnemo)
- LLM execution (that's DE)

## Tech Stack

- **Runtime**: Cloudflare Workers
- **Database**: Cloudflare D1 with app-layer encryption
- **State Management**: Durable Objects
- **Package Manager**: Bun (NOT npm)
- **Language**: TypeScript
- **LLM Operations**: Via DE service binding (no direct LLM API calls)

## Service Bindings

Nexus uses Cloudflare Service Bindings for zero-cost Worker-to-Worker communication:

| Binding | Service | Purpose |
|---------|---------|---------|
| `DE` | `text-gen` | LLM operations (chat completion, text generation) |

### Using the DE Client

```typescript
import { DEClient } from './lib/de-client.ts';

// In a handler or Durable Object method:
const deClient = new DEClient(env);

const response = await deClient.chatCompletion({
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello!' },
  ],
  max_tokens: 1000,
});

console.log(response.content);
```

**Important:** Never call LLM providers directly. Always use the DE client.

## DE Routing Architecture (Dec 2024)

**CRITICAL: All code execution must go through the correct routing path.**

### Correct Path
```
Nexus → POST /execute → PrimeWorkflow → CodeExecutionWorkflow → sandbox-executor
       (de-workflows)
```

### How Nexus Triggers Code Execution

1. **Via Intake Service Binding (preferred):**
   - `src/scheduled/task-executor.ts` uses `IntakeClient`
   - Calls `env.INTAKE.fetch('https://intake/intake', ...)` via service binding
   - Intake routes to PrimeWorkflow automatically

2. **Via HTTP to de-workflows (fallback):**
   - `src/mcp/index.ts` auto_dispatch uses `${env.DE_WORKFLOWS_URL}/execute`
   - Must always call `/execute`, NEVER `/workflows/*` endpoints

### Blocked Endpoints (403)

Direct calls to workflow endpoints are BLOCKED:
- ❌ `POST /workflows/code-execution` → Returns 403 `USE_EXECUTE_ENDPOINT`
- ❌ `POST /workflows/text-generation` → Returns 403 `USE_EXECUTE_ENDPOINT`
- ✅ `POST /execute` → Correct single entry point

### Error Indicators

These errors suggest routing issues (Nexus calling wrong endpoints):
- `ALL_RUNNERS_FAILED` - Sandbox-executor exhausted retries
- `RUNNER_UNREACHABLE` - Both Claude and Gemini runners failed
- `USE_EXECUTE_ENDPOINT` - Direct 403 from blocked endpoint

If you see these errors, check:
1. Nexus is calling `/execute` not `/workflows/*`
2. DE_WORKFLOWS_URL is set correctly in wrangler.toml
3. Intake service binding is configured

### Reference
See Nexus note `8915b506-1caa-46d7-8f42-b6ba2c282788` for full architecture details.

## Developer Guidelines (MCP Server)

### Required: Check Before Implementing

ALWAYS search the developer guides before:
- Writing new functions or modules
- Implementing error handling
- Adding validation logic
- Creating API endpoints
- Writing database queries
- Adding authentication or security features

This is not optional - established patterns must be followed for consistency and security.

### Quick Reference

| Task | Search Query |
|------|-------------|
| Input validation | `query="zod validation"` |
| Error handling | `query="error classes"` |
| API security | `query="authentication middleware"` |
| Database queries | `query="parameterized queries"` |
| Testing patterns | `query="unit test"` |
| Logging/monitoring | `query="observability"` |

### How to Access

Search by topic:
```
mcp__developer-guides__search_developer_guides query="validation"
```

Get specific guide:
```
mcp__developer-guides__get_guide guideId="guide-07-security"
mcp__developer-guides__get_guide guideId="guide-01-fundamentals"
```

List all available guides:
```
mcp__developer-guides__list_guides
```

### Available Guides

| Guide | Use For |
|-------|---------|
| `guide-01-fundamentals` | Code organization, naming, error handling, types |
| `guide-02-11-arch-devops` | Architecture patterns, CI/CD, deployment |
| `guide-05-10-db-perf` | Database schemas, queries, performance |
| `guide-07-security` | Validation, auth, secrets, CORS, rate limiting |
| `guide-09-testing` | Unit, integration, E2E testing patterns |
| `Cloudflare-Workers-Guide` | Cloudflare Workers patterns, bindings, KV, D1 |
| `Frontend-Development-Guide` | Frontend patterns, components, state management |
| `AI and Observability-Guide` | AI integration, logging, monitoring, tracing |

### Key Patterns to Follow
- Use Zod schemas for all input validation
- Use custom error classes (`AppError`, `ValidationError`, `NotFoundError`)
- Never concatenate SQL queries - use parameterized queries
- Store secrets in environment variables, never in code

### Improving the Guides

If you find gaps, outdated patterns, or better approaches while working:
```
mcp__developer-guides__propose_guide_change guideId="guide-07-security" section="Authentication" currentText="..." proposedText="..." rationale="Found a better pattern for..."
```
Proposals help keep the guides current and comprehensive.

## Architecture Decisions (Already Made)

1. **D1 with encryption** - Sensitive fields encrypted at app layer before storage
2. **UUID primary keys** - No auto-increment, enables offline creation
3. **tenant_id on every table** - Multi-tenant ready (single user for now)
4. **Soft deletes** - Never hard delete, use `deleted_at` timestamps
5. **Durable Objects for state** - UserSession, InboxManager, SyncManager, CaptureBuffer

## Project Status: Foundation Complete ✅

The core foundation has been built and tested. Current capabilities:

### Implemented Features

- **Full CRUD API** for all entities (tasks, projects, inbox, ideas, people, commitments, notes)
- **App-layer encryption** for sensitive fields (AES-256-GCM)
- **Zod validation** on all inputs with detailed error messages
- **Custom error classes** (AppError, ValidationError, NotFoundError, etc.)
- **InboxManager Durable Object** with capture, batch capture, queue, and WebSocket
- **AI Classification** via Claude API (auto-creates tasks with ≥80% confidence)
- **Cloudflare Access auth** for production (JWT validation via jose)
- **Dev token auth** for development (fallback)
- **Auto user provisioning** on first login
- **Test suite** with 97 passing tests

### API Structure

```
src/
├── index.ts                    # Main worker entry, Hono router
├── lib/
│   ├── auth.ts                 # Auth middleware (Cloudflare Access + dev JWT)
│   ├── classifier.ts           # Claude AI classification
│   ├── db.ts                   # D1 helpers with tenant scoping
│   ├── encryption.ts           # AES-256-GCM encryption
│   ├── errors.ts               # Custom error classes
│   └── validation.ts           # Zod schemas for all entities
├── routes/
│   ├── inbox.ts                # Inbox CRUD
│   ├── tasks.ts                # Tasks CRUD
│   ├── projects.ts             # Projects CRUD
│   ├── ideas.ts                # Ideas CRUD
│   ├── people.ts               # People CRUD
│   ├── commitments.ts          # Commitments CRUD
│   └── notes.ts                # Notes CRUD with source tracking
├── durable-objects/
│   └── InboxManager.ts         # Real-time capture & classification
└── types/
    └── index.ts                # TypeScript interfaces
```

### API Endpoints

| Endpoint | Methods | Description |
|----------|---------|-------------|
| `/api/tasks` | GET, POST, PATCH, DELETE | Task management |
| `/api/projects` | GET, POST, PATCH, DELETE | Project management |
| `/api/inbox` | GET, POST, PATCH, DELETE | Inbox items |
| `/api/ideas` | GET, POST, PATCH, DELETE | Ideas/someday-maybe |
| `/api/people` | GET, POST, PATCH, DELETE | Contacts |
| `/api/commitments` | GET, POST, PATCH, DELETE | Waiting-for/owed-to |
| `/api/notes` | GET, POST, PATCH, DELETE | Notes with source tracking |
| `/api/capture` | POST | Capture with AI classification |
| `/api/capture/batch` | POST | Batch capture |
| `/api/capture/status` | GET | InboxManager status |
| `/api/capture/queue` | GET | Classification queue |
| `/api/capture/ws` | WebSocket | Real-time updates |
| `/api/auth/me` | GET | Current user and tenant info |
| `/setup` | POST | Dev-only: create tenant/user |

## Fields to Encrypt

- `tasks.title`, `tasks.description`
- `inbox_items.raw_content`, `inbox_items.processed_content`
- `projects.name`, `projects.description`, `projects.objective`
- `ideas.title`, `ideas.description`
- `people.name`, `people.email`, `people.phone`, `people.notes`
- `commitments.description`
- `notes.title`, `notes.content`

## Authentication

Nexus uses **Cloudflare Access** for production authentication. Access handles the OAuth flow and injects a JWT into requests via the `Cf-Access-Jwt-Assertion` header.

### How It Works

1. User visits the app URL protected by Cloudflare Access
2. Access redirects to login (Google, GitHub, email OTP, etc.)
3. After auth, Access injects JWT into all requests
4. Worker validates JWT using jose library against Access JWKS
5. On first login, user/tenant auto-provisioned with encryption key

### Setting Up Cloudflare Access (Production)

1. **Create Access Application**:
   - Go to [Cloudflare One Dashboard](https://one.dash.cloudflare.com/)
   - Navigate to **Access** → **Applications** → **Add an application**
   - Choose **Self-hosted** and enter your Worker URL
   - Configure authentication methods (Google, GitHub, email OTP, etc.)

2. **Get Your Configuration**:
   - Copy **Team Domain** (e.g., `https://your-team.cloudflareaccess.com`)
   - Copy **Application Audience (AUD) Tag** from application settings

3. **Set Environment Variables**:
   ```bash
   # Add to wrangler.toml [vars] section or set as secrets
   npx wrangler secret put TEAM_DOMAIN
   # Enter: https://your-team.cloudflareaccess.com

   npx wrangler secret put POLICY_AUD
   # Enter: your-application-aud-tag
   ```

4. **Deploy**:
   ```bash
   npm run deploy
   ```

### Development Mode

In development (`ENVIRONMENT=development`), the dev token flow still works:

```bash
# Start dev server
npm run dev

# Create a dev user and get token
curl -X POST http://localhost:8787/setup

# Use the returned token
curl -H "Authorization: Bearer <token>" http://localhost:8787/api/tasks
```

### Auth Flow Diagram

```
Production (Cloudflare Access):
Browser → Access Login → Access injects JWT → Worker validates → Auto-provision user

Development:
POST /setup → Returns dev token → Use Bearer token → Worker validates
```

## Secrets Management

**All secrets are stored in Cloudflare Workers Secrets** - never in code or `.env` files.

### Required Secrets

| Secret | Description |
|--------|-------------|
| `TEAM_DOMAIN` | Cloudflare Access team domain (production) |
| `POLICY_AUD` | Cloudflare Access application audience tag (production) |
| `WRITE_PASSPHRASE` | Passphrase for MCP write operations |

**Note:** `ANTHROPIC_API_KEY` is NOT needed in Nexus. All LLM operations go through DE (distributed-electrons) via service binding.

### Managing Secrets

```bash
# List all secrets
npm run secret:list

# Add/update a secret
npm run secret:put WRITE_PASSPHRASE
# (prompts for value)

# Or directly with wrangler
npx wrangler secret put WRITE_PASSPHRASE
```

### Local Development with Secrets

For local dev, you have two options:

1. **Use remote bindings** (recommended - uses production secrets and service bindings):
   ```bash
   bun run dev:remote
   ```

2. **Create `.dev.vars`** (local-only secrets):
   ```bash
   # Cloudflare API Token for Wrangler CLI (development/deployment only)
   # Permissions needed:
   #   Account: Account Settings (Read), Workers KV Storage (Edit), Workers R2 Storage (Edit), D1 (Edit), Workers Scripts (Edit)
   #   Zone: Workers Routes (Edit)
   CLOUDFLARE_API_TOKEN=your-token-here
   WRITE_PASSPHRASE=your-dev-passphrase
   ```
   Create a token at https://dash.cloudflare.com/profile/api-tokens

   Note: `.dev.vars` is gitignored and should never be committed.

**Important:** For LLM functionality in local dev, you must use `npm run dev:remote` to access the DE service binding.

## Testing

```bash
# Run unit tests
npm test

# Watch mode
npm run test:watch

# Run local dev server
npm run dev

# Run with remote bindings (for secrets/D1)
npm run dev:remote

# Test endpoints
curl http://localhost:8787/api/tasks
```

## Deployment

**Worker name:** `nexus-mcp` (configured in wrangler.toml)
**MCP URL:** `https://nexus-mcp.solamp.workers.dev/mcp`

```bash
# Deploy to Cloudflare (deploys to nexus-mcp worker)
bun run deploy

# Deploy schema to remote D1
bun run db:migrate:remote
```

**Important:** Always use `bun run deploy` which deploys to the `nexus-mcp` worker that Claude.ai connects to.

## Important Notes

- Use `crypto.randomUUID()` for all IDs
- Always include `tenant_id` in WHERE clauses
- Return proper HTTP status codes
- Log errors but don't expose internals to client
- All timestamps in ISO 8601 format

## Project Status

### Completed
- **Production Auth** - Cloudflare Access JWT validation ✅
- **Service Token Auth** - CF Access service tokens for M2M auth ✅
- **Durable Objects** - UserSession, SyncManager, CaptureBuffer, InboxManager, IdeaExecutor ✅
- **Recurring Tasks** - Scheduler with cron triggers ✅
- **Web Dashboard Foundation** - Qwik app with core pages ✅
- **AI Classification** - Claude-powered inbox item classification ✅
- **Execution Loop** - IdeaExecutionLoop with plan generation and task creation ✅
- **Notes System** - Persistent notes with encryption, source tracking, and MCP tools ✅
- **Task Dispatcher** - Cron-based task routing to executors (claude-code, claude-ai, de-agent, human) ✅

### In Progress
- **Task Review Loop** - Triage framework for task routing (see `docs/TASK_REVIEW_LOOP.md`)
- **Web Dashboard Completion** - Finish placeholder pages (Projects, Ideas, People, Commitments)
- **Mnemo Integration** - Context orchestration (Nexus tells Mnemo what to load)
- **Email Integration** - Gmail/IMAP ingestion and classification

### Recently Completed
- **CodeExecutionLoop** - Auto-execute code/documentation tasks via DE Workflows ✅
  - HTTP triggers for cross-worker workflow execution
  - Callback handlers for execution results
  - See `docs/EXECUTION_LOOP.md` for full architecture

## Execution Loop Hierarchy

Nexus operates through a hierarchy of execution loops for autonomous task processing.
See `docs/EXECUTION_LOOP.md` for full documentation (idea triage, task review, execution loops).

```
                    ┌─────────────────────────┐
                    │   IdeaExecutionLoop     │  ← Parent Loop (implemented)
                    │   (Idea → Plan → Tasks) │
                    └───────────┬─────────────┘
                                │
            ┌───────────────────┼───────────────────┐
            │                   │                   │
            ▼                   ▼                   ▼
┌───────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ CodeExecutionLoop │ │  ResearchLoop   │ │  ContentLoop    │
│ (Code/Docs tasks) │ │ (Investigation) │ │ (Writing/Media) │
└───────────────────┘ └─────────────────┘ └─────────────────┘
    (implemented)          (planned)           (planned)
```

### Loop Trigger Flow
1. Idea enters system → IdeaExecutionLoop generates plan
2. Plan decomposes into tasks with `loop_type` (code, research, content)
3. Tasks go through review (routing, SMART criteria, priority)
4. Ready tasks trigger appropriate child loop
5. Child loops execute autonomously until complete or blocked
6. Blockers escalate: Child → Parent → Nexus → Bridge (human)

### Current API Endpoints
- `POST /api/execution/ideas/:id/plan` - Generate AI plan from idea
- `POST /api/execution/ideas/:id/execute` - Create tasks from plan
- `GET /api/execution/ideas/:id/status` - Get execution status
- `GET /api/execution/active` - List all active executions
- `POST /api/execution/ideas/:id/cancel` - Cancel execution
- `GET /api/execution/decisions` - Decision log

## Task Dispatcher System

Automated task routing system that polls for ready tasks and dispatches them to appropriate executors.

### How It Works

1. **Cron Trigger**: Runs every 15 minutes (`*/15 * * * *`)
2. **Task Detection**: Finds tasks with `status = 'next'` (ready for execution)
3. **Executor Routing**: Routes based on task title prefix tags
4. **Queue Management**: Tracks execution state in `execution_queue` table

### Executor Types

Key principle: **Nexus asks "Does a human need to be involved?"** - it does NOT care about HOW AI tasks are executed (that's DE's problem).

| Type | Description | Routed From | Auto-Dispatch |
|------|-------------|-------------|---------------|
| `human` | Human only, never auto-dispatch | `[human]`, `[call]`, `[meeting]`, `[BLOCKED]` | No |
| `human-ai` | Human leads, AI assists | `[review]`, `[approve]`, `[decide]` | No |
| `ai` | Full AI autonomy, auto-dispatch to DE | `[implement]`, `[fix]`, `[research]`, `[write]`, etc. | Yes |

**Legacy tag support**: `[claude-code]`, `[claude-ai]`, `[de-agent]`, `[CC]`, `[DE]` all map to `ai`.

Tasks without prefix tags default to `human` for triage.

### MCP Tools for Queue Management

```typescript
// Check queue for tasks ready to execute
nexus_check_queue({ executor_type: 'ai' })

// Claim a task to work on it
nexus_claim_task({ queue_id: '...', passphrase: '...' })

// Mark task completed
nexus_complete_queue_task({ queue_id: '...', result: '...', passphrase: '...' })

// Get queue statistics
nexus_queue_stats()

// MANUAL DISPATCH - Immediately queue tasks without waiting for cron
nexus_dispatch_task({ task_id: '...', passphrase: '...' })  // Single task
nexus_dispatch_ready({ executor_type: 'ai', passphrase: '...' })  // All ready tasks
```

### REST API Endpoints

```
POST /api/tasks/:id/dispatch   - Dispatch single task
  Body: { executor_type?: string }

POST /api/dispatch/ready       - Dispatch all tasks with status="next"
  Body: { executor_type?: string, limit?: number }
```

### Execution Flow

```
Task created with status="next"
        ↓
Cron trigger (every 15 min) OR manual: nexus_dispatch_task
        ↓
Dispatcher routes to queue based on title tag
        ↓
Executor checks queue: nexus_check_queue
        ↓
Executor claims task: nexus_claim_task
        ↓
Executor gets context: nexus_trigger_task
        ↓
Executor does work
        ↓
Executor reports: nexus_complete_queue_task
        ↓
Auto-dispatch checks for newly ready tasks
        ↓
Response includes next_available tasks → loop continues
```

### Auto-Dispatch on Completion

When `nexus_complete_queue_task` is called, it automatically:
1. Checks for already-queued tasks for the same executor type
2. Finds newly ready tasks (`status="next"`) that match this executor
3. Dispatches them immediately (no waiting for cron)
4. Returns `next_available` list so executor can claim next task

This enables continuous execution loops without polling delays.

### Database Tables

- `execution_queue` - Active queue entries with status tracking
- `dispatch_log` - Immutable audit trail of all dispatch actions

### Circuit Breaker

Prevents runaway retry loops when tasks fail repeatedly. If a task has 3+ quarantined queue entries in the last 24 hours, the circuit breaker trips and the task is automatically cancelled instead of creating another queue entry.

**Configuration:**
- Threshold: 3 quarantine entries
- Window: 24 hours
- Action: Task status set to 'cancelled', logged to dispatch_log

**When it triggers:**
- Task fails max retries (3) and gets quarantined
- Same task keeps getting re-dispatched by cron
- After 3 quarantine entries, circuit breaker stops the loop

**Checked at:**
- Cron dispatch (`dispatchTasks`)
- Manual dispatch (`nexus_dispatch_task`, `nexus_dispatch_ready`)
- Auto-dispatch on completion (`nexus_complete_queue_task`)
- REST API dispatch (`POST /api/tasks/:id/dispatch`)
- Dependency promotion (`promoteDependentTasks`)

**Recovery:**
To retry a task after fixing the underlying issue:
1. Update task status back to 'next': `nexus_update_task({ task_id, status: 'next' })`
2. The quarantine entries will age out after 24 hours
3. Or manually clean up with `nexus_cleanup_queue`

### Cron Configuration

```toml
[triggers]
crons = [
  "0 0 * * *",     # Daily at midnight - recurring tasks
  "*/15 * * * *"   # Every 15 min - task dispatcher
]
```

## Notes System

Persistent note storage with source tracking - designed to capture knowledge from various sources (Claude conversations, idea executions, meetings, research).

### Note Categories
| Category | Use Case |
|----------|----------|
| `general` | Default, general-purpose notes |
| `meeting` | Meeting notes and action items |
| `research` | Research findings and references |
| `reference` | Reference material, documentation |
| `idea` | Idea elaborations and explorations |
| `log` | Activity logs, status updates |

### Source Tracking
Notes can track where they originated from:
- `source_type`: Origin type (e.g., `claude_conversation`, `idea_execution`, `manual`, `capture`)
- `source_reference`: Reference ID or URL
- `source_context`: Additional context about the source

### API Endpoints
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/notes` | GET | List notes (with filters: category, archived, pinned, search, source_type) |
| `/api/notes` | POST | Create note |
| `/api/notes/:id` | GET | Get single note |
| `/api/notes/:id` | PATCH | Update note |
| `/api/notes/:id` | DELETE | Soft delete note |
| `/api/notes/:id/archive` | POST | Archive note |
| `/api/notes/:id/unarchive` | POST | Unarchive note |
| `/api/notes/:id/pin` | POST | Toggle pin status |

### MCP Tools
Available via the Nexus MCP server:
- `nexus_create_note` - Create a new note (requires passphrase)
- `nexus_list_notes` - List notes with optional filters
- `nexus_get_note` - Get a specific note by ID
- `nexus_update_note` - Update an existing note (requires passphrase)
- `nexus_delete_note` - Soft delete a note (requires passphrase)
- `nexus_archive_note` - Archive/unarchive a note (requires passphrase)
- `nexus_search_notes` - Search notes by content

### Database Schema
```sql
CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,        -- encrypted
    content TEXT,               -- encrypted
    category TEXT DEFAULT 'general',
    tags TEXT,                  -- JSON array
    source_type TEXT,
    source_reference TEXT,
    source_context TEXT,
    pinned INTEGER DEFAULT 0,
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
);
```

## Idea Management System (Priority Feature)

Core feature: Capture, organize, and execute on Chris's ideas with minimal friction.

### Idea Inbox
- Fast capture from any input (voice, text, API, Claude conversations)
- Auto-tag and categorize via AI classification
- Link to related projects/repos/conversations
- No friction - dump now, organize later
- Integrate with existing `/api/ideas` endpoint

### Prioritization Engine
- Weigh ideas against each other (pairwise comparison)
- Scoring factors:
  - Effort estimate (T-shirt sizing or hours)
  - Impact potential (1-10)
  - Dependencies (blocked by other ideas/tasks)
  - Energy/mood fit (creative vs analytical vs maintenance)
- Surface "ready to execute" ideas based on current context
- Age/decay stale ideas, prompt for periodic review

### Idea → Execution Pipeline
- Break ideas into specs/tasks automatically
- Assign to agent swarm:
  - Claude API (via DE) for complex analysis
  - Local models for quick tasks
  - Specialized agents for specific domains
- Track progress async (24/7 execution)
- Surface blockers requiring CEO decision
- Aggregate results for review

### CEO Dashboard
- What's in progress (active agent work)
- What needs my input (blockers, decisions)
- What's ready for review (completed work)
- Quick approve/reject/redirect actions
- Daily/weekly summaries

### Decision Log
- Record when ideas are acted on or killed
- Capture reasoning for future reference
- Learn patterns over time (what gets approved, what gets killed)
- Enable "why did I decide X?" lookups

### Database Schema Additions

```sql
-- Idea prioritization
ALTER TABLE ideas ADD COLUMN effort_estimate TEXT; -- xs, s, m, l, xl
ALTER TABLE ideas ADD COLUMN impact_score INTEGER; -- 1-10
ALTER TABLE ideas ADD COLUMN energy_type TEXT; -- creative, analytical, maintenance
ALTER TABLE ideas ADD COLUMN dependencies TEXT; -- JSON array of idea/task IDs
ALTER TABLE ideas ADD COLUMN priority_score REAL; -- Calculated score

-- Execution tracking
CREATE TABLE idea_executions (
  execution_id TEXT PRIMARY KEY,
  idea_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL, -- pending, in_progress, blocked, completed, failed
  assigned_agent TEXT, -- agent identifier
  started_at TEXT,
  completed_at TEXT,
  result TEXT, -- JSON result data
  blockers TEXT, -- JSON array of blockers
  FOREIGN KEY (idea_id) REFERENCES ideas(idea_id)
);

-- Decision log
CREATE TABLE decisions (
  decision_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  entity_type TEXT NOT NULL, -- idea, task, project
  entity_id TEXT NOT NULL,
  decision TEXT NOT NULL, -- approved, rejected, deferred, modified
  reasoning TEXT,
  context TEXT, -- JSON context at decision time
  created_at TEXT NOT NULL
);
```

### Long-term Vision

Autonomous development organization with Chris as CEO:
- Agents work 24/7, executing on approved ideas
- Nexus orchestrates work distribution and progress tracking
- Chris provides direction, taste, and key decisions
- System learns from decisions to improve prioritization

### Future Phases
- Google Calendar integration
- Cross-device sync
- Mobile clients (via Bridge project)
