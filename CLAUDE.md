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
| `/api/auth/me` | GET | Current user and tenant info |
| `/setup` | POST | Dev-only: create tenant/user |

## Fields to Encrypt

- `tasks.title`, `tasks.description`
- `inbox_items.raw_content`, `inbox_items.processed_content`
- `projects.name`, `projects.description`, `projects.objective`
- `ideas.title`, `ideas.description`
- `people.name`, `people.email`, `people.phone`, `people.notes`
- `commitments.description`

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
| `ANTHROPIC_API_KEY` | Claude API key for AI classification |
| `TEAM_DOMAIN` | Cloudflare Access team domain (production) |
| `POLICY_AUD` | Cloudflare Access application audience tag (production) |

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

## Project Status

### Completed
- **Production Auth** - Cloudflare Access JWT validation ✅
- **Durable Objects** - UserSession, SyncManager, CaptureBuffer, InboxManager ✅
- **Recurring Tasks** - Scheduler with cron triggers ✅
- **Web Dashboard Foundation** - Qwik app with core pages ✅

### In Progress
- **Web Dashboard Completion** - Finish placeholder pages (Projects, Ideas, People, Commitments)
- **Speech-to-Text** - Integrate with Cloudflare AI or external STT service

### Future Phases
- Android client with continuous voice capture
- Google Calendar integration
- Email integration (Gmail/IMAP)
- Cross-device sync
