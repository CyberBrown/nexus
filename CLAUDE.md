<!-- Developer Guides MCP Setup v1.1.0 - Check for updates: docs/CLAUDE-MD-SETUP.md -->
# CLAUDE.md - Nexus Project Instructions

## Project Overview

Nexus is a Personal AI Command Center - a voice-first, AI-native productivity system that captures, organizes, prioritizes, and surfaces the right information at the right time.

## Tech Stack

- **Runtime**: Cloudflare Workers
- **Database**: Cloudflare D1 with app-layer encryption
- **State Management**: Durable Objects
- **Package Manager**: Bun (NOT npm)
- **Language**: TypeScript

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

- **Full CRUD API** for all entities (tasks, projects, inbox, ideas, people, commitments)
- **App-layer encryption** for sensitive fields (AES-256-GCM)
- **Zod validation** on all inputs with detailed error messages
- **Custom error classes** (AppError, ValidationError, NotFoundError, etc.)
- **InboxManager Durable Object** with capture, batch capture, queue, and WebSocket
- **AI Classification** via Claude API (auto-creates tasks with ≥80% confidence)
- **Dev token auth** for development
- **Test suite** with 53 passing tests

### API Structure

```
src/
├── index.ts                    # Main worker entry, Hono router
├── lib/
│   ├── auth.ts                 # Auth middleware (dev JWT)
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
│   └── commitments.ts          # Commitments CRUD
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
| `/api/capture` | POST | Capture with AI classification |
| `/api/capture/batch` | POST | Batch capture |
| `/api/capture/status` | GET | InboxManager status |
| `/api/capture/queue` | GET | Classification queue |
| `/api/capture/ws` | WebSocket | Real-time updates |
| `/setup` | POST | Dev-only: create tenant/user |

## Fields to Encrypt

- `tasks.title`, `tasks.description`
- `inbox_items.raw_content`, `inbox_items.processed_content`
- `projects.name`, `projects.description`, `projects.objective`
- `ideas.title`, `ideas.description`
- `people.name`, `people.email`, `people.phone`, `people.notes`
- `commitments.description`

## Secrets Management

**All secrets are stored in Cloudflare Workers Secrets** - never in code or `.env` files.

### Required Secrets

| Secret | Description |
|--------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key for AI classification |

### Managing Secrets

```bash
# List all secrets
npm run secret:list

# Add/update a secret
npm run secret:put ANTHROPIC_API_KEY
# (prompts for value)

# Or directly with wrangler
npx wrangler secret put ANTHROPIC_API_KEY
```

### Local Development with Secrets

For local dev, you have two options:

1. **Use remote bindings** (recommended - uses production secrets):
   ```bash
   npm run dev:remote
   ```

2. **Create `.dev.vars`** (local-only secrets):
   ```bash
   echo "ANTHROPIC_API_KEY=sk-ant-..." > .dev.vars
   ```
   Note: `.dev.vars` is gitignored and should never be committed.

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

```bash
# Deploy to Cloudflare
npm run deploy

# Deploy schema to remote D1
npm run db:migrate:remote
```

## Important Notes

- Use `crypto.randomUUID()` for all IDs
- Always include `tenant_id` in WHERE clauses
- Return proper HTTP status codes
- Log errors but don't expose internals to client
- All timestamps in ISO 8601 format

## Next Phase

Ready to build:
- **Production Auth** - Replace dev JWT with OAuth/Clerk
- **Remaining Durable Objects** - UserSession, SyncManager, CaptureBuffer
- **Recurring Tasks** - Logic to spawn recurring task instances
- **Web Dashboard** - UI for reviewing/organizing captured items

Future phases:
- Android client with continuous voice capture
- Google Calendar integration
- Email integration (Gmail/IMAP)
- Cross-device sync
