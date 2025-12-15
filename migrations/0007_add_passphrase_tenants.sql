-- Migration: Add passphrase_tenants mapping table
-- Maps passphrase hashes to tenants for MCP authentication without Cloudflare Access

CREATE TABLE IF NOT EXISTS passphrase_tenants (
    id TEXT PRIMARY KEY,
    passphrase_hash TEXT NOT NULL UNIQUE,  -- SHA-256 hash of the passphrase
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT,  -- Friendly name for this access (e.g., "Claude.ai MCP Access")

    -- Usage tracking
    last_used_at TEXT,
    use_count INTEGER DEFAULT 0,

    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
);

-- Index for fast lookup by passphrase hash
CREATE INDEX IF NOT EXISTS idx_passphrase_tenants_hash ON passphrase_tenants(passphrase_hash);
CREATE INDEX IF NOT EXISTS idx_passphrase_tenants_tenant ON passphrase_tenants(tenant_id);
