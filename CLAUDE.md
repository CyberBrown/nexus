# CLAUDE.md - Nexus Project Instructions

## Project Overview

Nexus is a Personal AI Command Center - a voice-first, AI-native productivity system that captures, organizes, prioritizes, and surfaces the right information at the right time.

## Tech Stack

- **Runtime**: Cloudflare Workers
- **Database**: Cloudflare D1 with app-layer encryption
- **State Management**: Durable Objects
- **Package Manager**: Bun (NOT npm)
- **Language**: TypeScript

## Architecture Decisions (Already Made)

1. **D1 with encryption** - Sensitive fields encrypted at app layer before storage
2. **UUID primary keys** - No auto-increment, enables offline creation
3. **tenant_id on every table** - Multi-tenant ready (single user for now)
4. **Soft deletes** - Never hard delete, use `deleted_at` timestamps
5. **Durable Objects for state** - UserSession, InboxManager, SyncManager, CaptureBuffer

## Current Task: Foundation Setup

### Step 1: Create D1 Database

```bash
# Use Cloudflare dashboard or wrangler
wrangler d1 create nexus-db
```

Note the database ID for wrangler.toml.

### Step 2: Scaffold Worker Project

```bash
bunx create-cloudflare@latest nexus --type worker-ts
cd nexus
```

### Step 3: Configure wrangler.toml

```toml
name = "nexus"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[[d1_databases]]
binding = "DB"
database_name = "nexus-db"
database_id = "<YOUR_DATABASE_ID>"

[vars]
ENVIRONMENT = "development"

# KV for encryption keys (create this too)
[[kv_namespaces]]
binding = "KV"
id = "<YOUR_KV_ID>"
```

### Step 4: Deploy Schema

```bash
wrangler d1 execute nexus-db --file=./schema.sql
```

The schema file is `nexus-schema.sql` in this directory.

### Step 5: Create Encryption Utilities

Create `src/lib/encryption.ts`:

```typescript
// AES-256-GCM encryption for sensitive fields
// Key stored in KV, referenced by tenant

export async function getEncryptionKey(kv: KVNamespace, tenantId: string): Promise<CryptoKey> {
  const keyData = await kv.get(`tenant:${tenantId}:key`, 'arrayBuffer');
  if (!keyData) {
    throw new Error('Encryption key not found for tenant');
  }
  
  return crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptField(value: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(value);
  
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded
  );
  
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  
  return btoa(String.fromCharCode(...combined));
}

export async function decryptField(encrypted: string, key: CryptoKey): Promise<string> {
  const combined = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);
  
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );
  
  return new TextDecoder().decode(decrypted);
}

export async function generateTenantKey(kv: KVNamespace, tenantId: string): Promise<void> {
  const key = crypto.getRandomValues(new Uint8Array(32));
  await kv.put(`tenant:${tenantId}:key`, key);
}
```

### Step 6: Create Basic API Structure

```
src/
├── index.ts              # Main worker entry, router
├── lib/
│   ├── encryption.ts     # Encryption utilities
│   ├── auth.ts           # Auth middleware
│   └── db.ts             # D1 helpers with tenant scoping
├── routes/
│   ├── inbox.ts          # Inbox CRUD
│   ├── tasks.ts          # Tasks CRUD
│   └── projects.ts       # Projects CRUD
└── types/
    └── index.ts          # TypeScript interfaces
```

### Step 7: Implement Basic CRUD

For each entity (inbox_items, tasks, projects), implement:
- `GET /api/{entity}` - List with tenant filtering
- `GET /api/{entity}/:id` - Get single
- `POST /api/{entity}` - Create
- `PATCH /api/{entity}/:id` - Update
- `DELETE /api/{entity}/:id` - Soft delete

All routes must:
1. Check auth (simple JWT for now)
2. Scope queries by tenant_id
3. Encrypt sensitive fields before write
4. Decrypt sensitive fields after read

## Fields to Encrypt

- `tasks.title`, `tasks.description`
- `inbox_items.raw_content`, `inbox_items.processed_content`
- `projects.name`, `projects.description`, `projects.objective`
- `ideas.title`, `ideas.description`
- `people.name`, `people.email`, `people.phone`, `people.notes`
- `commitments.description`

## Testing

```bash
# Run locally
bun run dev

# Test endpoints
curl http://localhost:8787/api/tasks
```

## Deployment

```bash
bun run deploy
# or
wrangler deploy
```

## Important Notes

- Use `crypto.randomUUID()` for all IDs
- Always include `tenant_id` in WHERE clauses
- Return proper HTTP status codes
- Log errors but don't expose internals to client
- All timestamps in ISO 8601 format

## Next Phase (Don't Build Yet)

After foundation is solid:
- Durable Objects for real-time sync
- Android client with continuous capture
- AI classification pipeline
- Calendar/email integrations
