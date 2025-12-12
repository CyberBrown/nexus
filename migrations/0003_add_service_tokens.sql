-- Migration: Add service_tokens table for machine-to-machine auth
-- This allows external services (like MCP servers) to authenticate with Nexus

CREATE TABLE IF NOT EXISTS service_tokens (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id),

    name TEXT NOT NULL,
    description TEXT,

    client_id TEXT NOT NULL UNIQUE,
    client_secret_hash TEXT NOT NULL,

    scopes TEXT,

    last_used_at TEXT,
    expires_at TEXT,
    revoked_at TEXT,

    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_service_tokens_tenant ON service_tokens(tenant_id);
CREATE INDEX IF NOT EXISTS idx_service_tokens_client_id ON service_tokens(client_id);
