# Nexus

**The Brain** - Orchestration layer for AI infrastructure: Tier 1 processing, memory management, and service coordination.

## Ecosystem Role

Nexus is the central orchestrator in the AI infrastructure ecosystem:

| Pillar | Role |
|--------|------|
| **Nexus** (this) | The Brain - orchestration, Tier 1, memory management |
| [Mnemo](https://github.com/Logos-Flux/mnemo) | Working Memory - context caching only (no decisions) |
| [DE](https://github.com/CyberBrown/distributed-electrons) | Arms & Legs - Tier 2+ execution, LLM routing |
| Bridge (future) | User Interface - voice, text, all user-facing |

### How It Works

```
User → Bridge → Nexus → (Tier 1 local OR Tier 2 via DE) → Response
                  ↓
               Mnemo (loads what Nexus tells it to)
```

### Core Responsibilities

**Tier 1 Processing:**
- Fast edge AI classification
- Input triage and routing
- Escalation decisions (when to use DE)

**Active Memory Manager:**
- Entity detection in conversations
- Session awareness and tracking
- Proactive context loading (tells Mnemo what to load)
- Memory tier management (HOT/WARM/COLD)

**Long-term Memory:**
- Persistent storage and retrieval
- Cross-session knowledge
- User preferences and patterns

**Task/Project Management:**
- Inbox processing
- Task and project CRUD
- Email/calendar ingestion (future)

## Current Status: Foundation Complete

### What's Working

- Full CRUD API for tasks, projects, inbox, ideas, people, commitments
- AI classification via Claude (auto-creates tasks at >= 80% confidence)
- Recurring tasks with full RRULE support
- App-layer encryption (AES-256-GCM)
- Multi-tenant architecture (tenant_id on all tables)
- 4 Durable Objects: InboxManager, CaptureBuffer, SyncManager, UserSession
- Web dashboard (Qwik/Cloudflare Pages) - home, capture, inbox, tasks
- 93+ passing tests

### Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Cloudflare Workers |
| Database | Cloudflare D1 |
| State | Durable Objects |
| Package Manager | Bun |
| Frontend | Qwik (Cloudflare Pages) |
| Language | TypeScript |

## Quick Start

```bash
# Install dependencies
bun install

# Run local development server
bun run dev

# Run with remote bindings (secrets/D1)
bun run dev:remote

# Run tests
bun test

# Deploy to Cloudflare
bun run deploy
```

## API Endpoints

| Endpoint | Methods | Description |
|----------|---------|-------------|
| `/api/tasks` | GET, POST, PATCH, DELETE | Task management |
| `/api/projects` | GET, POST, PATCH, DELETE | Project management |
| `/api/inbox` | GET, POST, PATCH, DELETE | Inbox items |
| `/api/ideas` | GET, POST, PATCH, DELETE | Someday/maybe items |
| `/api/people` | GET, POST, PATCH, DELETE | Contacts |
| `/api/commitments` | GET, POST, PATCH, DELETE | Waiting-for/owed-to |
| `/api/capture` | POST | AI-classified capture |
| `/api/capture/batch` | POST | Batch capture |
| `/api/capture/ws` | WebSocket | Real-time updates |
| `/api/sync/*` | Various | Cross-device sync |
| `/api/session/*` | Various | Session management |

## Roadmap

### Next Up
1. **Production auth** - Replace dev JWT with OAuth/Clerk
2. **Complete dashboard** - Projects, Ideas, People, Commitments pages
3. **Mnemo integration** - Context orchestration
4. **Email ingestion** - Gmail/IMAP integration

### Idea Management System (Priority Feature)

Core feature: Capture, organize, and execute on ideas with minimal friction.

**Idea Inbox:**
- Fast capture from any input (voice, text, API, Claude conversations)
- Auto-tag and categorize via AI
- Link to related projects/repos/conversations
- No friction - dump now, organize later

**Prioritization Engine:**
- Weigh ideas against each other
- Factor in: effort, impact, dependencies, mood/energy
- Surface "ready to execute" ideas
- Age/decay stale ideas, prompt for review

**Idea → Execution Pipeline:**
- Break ideas into specs/tasks
- Assign to agent swarm (Claude API, local models, specialized agents)
- Track progress async (24/7 execution)
- Surface blockers for CEO decision
- Aggregate results for review

**CEO Dashboard:**
- What's in progress
- What needs my input
- What's ready for review
- Quick approve/reject/redirect

**Decision Log:**
- Record when ideas are acted on or killed
- Capture reasoning for future reference
- Learn patterns over time

### Long-term Vision

Autonomous development organization with Chris as CEO:
- Agents work 24/7
- Nexus orchestrates
- Chris provides direction and taste

### Future
- Google Calendar sync
- Cross-device sync
- Mobile clients (via Bridge)

## Documentation

- [CLAUDE.md](./CLAUDE.md) - Development guide and patterns
- [docs/features/](./docs/features/) - Feature documentation
- [Recurring Tasks Guide](./docs/features/RecurringTasks.md)

## License

MIT
