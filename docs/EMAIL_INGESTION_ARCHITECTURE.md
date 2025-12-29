# Email Ingestion Architecture Design

## Overview

This document defines the architecture for email ingestion into Nexus, enabling automatic capture and classification of emails into the AI Command Center. The system will support multiple ingestion mechanisms (Gmail API, IMAP, webhooks) while maintaining the existing multi-tenant, encrypted data model.

## Goals

1. **Capture emails with minimal latency** - Real-time or near-real-time ingestion
2. **Preserve full email context** - Headers, body, attachments, threading
3. **Integrate with existing classification** - Feed emails through AI classifier
4. **Support multiple providers** - Gmail initially, then IMAP for broader support
5. **Maintain security** - Encrypted storage, OAuth 2.0, tenant isolation

---

## Ingestion Mechanisms

### 1. Gmail API (Push via Pub/Sub) - **Recommended Primary**

**How it works:**
- Google Cloud Pub/Sub receives push notifications when emails arrive
- Cloudflare Worker endpoint receives Pub/Sub messages
- Worker fetches full email content via Gmail API
- Worker processes and stores email

**Pros:**
- Near-instant delivery (seconds)
- Official Google integration
- Efficient - only notified of new mail
- Full Gmail API access (labels, threading, search)

**Cons:**
- Requires Google Cloud Project setup
- OAuth 2.0 token management complexity
- Pub/Sub push requires public HTTPS endpoint

**Architecture:**
```
┌─────────────┐     ┌─────────────┐     ┌──────────────────┐
│   Gmail     │────▶│  Pub/Sub    │────▶│  Nexus Worker    │
│   Inbox     │     │  Push       │     │  /api/email/push │
└─────────────┘     └─────────────┘     └────────┬─────────┘
                                                  │
                                                  ▼
                         ┌──────────────────────────────────────┐
                         │            Gmail API                  │
                         │  - Fetch full message                 │
                         │  - Get attachments                    │
                         │  - Read thread context                │
                         └──────────────────────────────────────┘
```

### 2. Gmail API (Polling) - **Fallback**

**How it works:**
- Scheduled cron trigger polls Gmail API
- Uses `history.list` with `historyId` for incremental sync
- Fetches only new messages since last sync

**Pros:**
- Simpler setup (no Pub/Sub)
- Works without external dependencies
- Good for initial development

**Cons:**
- Latency (polling interval determines delay)
- Less efficient (constant API calls)
- Uses more API quota

**Polling Strategy:**
```
Initial sync: list() with maxResults=500
Subsequent: history.list(startHistoryId)
Frequency: Every 5 minutes via cron
```

### 3. IMAP - **Future Extension**

**How it works:**
- Connect to IMAP server from edge (limited support)
- Use IDLE command for push notifications
- Alternative: Poll via scheduled worker

**Pros:**
- Works with any email provider
- No vendor lock-in
- Supports legacy systems

**Cons:**
- IMAP IDLE requires persistent connections (not suitable for serverless)
- Complex protocol to implement correctly
- Must handle connection management

**Recommendation:** Use a bridge service (Cloudflare Queues + IMAP polling from a dedicated VM/container) or defer IMAP support.

### 4. Email Forwarding Webhook - **Simple Alternative**

**How it works:**
- User sets up email forwarding rule to Nexus email address
- Nexus receives emails via inbound email handler
- Process and classify on receipt

**Cloudflare Email Workers:**
```
┌─────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│   User's    │────▶│  Cloudflare Email    │────▶│  Email Worker   │
│   Inbox     │     │  Routing             │     │  (Process)      │
└─────────────┘     └──────────────────────┘     └─────────────────┘
       │
       ▼
  Forward Rule:
  inbox@nexus.yourdomain.com
```

**Pros:**
- Very simple implementation
- No OAuth complexity
- Works with any provider that supports forwarding

**Cons:**
- User must configure forwarding
- May miss emails if forwarding fails
- Less metadata available

---

## Recommended Implementation Phases

### Phase 1: Gmail API with Polling (MVP)
- Implement OAuth 2.0 flow via reauth-ui
- Store tokens in `integrations` table (encrypted)
- Poll every 5 minutes via cron
- Basic email parsing and classification

### Phase 2: Gmail Push Notifications
- Set up Google Cloud Pub/Sub
- Implement push endpoint
- Reduce polling to backup only

### Phase 3: Email Forwarding (Alternative Path)
- Implement Cloudflare Email Workers
- Allow users to forward specific emails

### Phase 4: IMAP Support (Optional)
- Evaluate need based on user feedback
- Consider dedicated IMAP relay service

---

## Data Model

### New Tables

```sql
-- ============================================
-- EMAIL MESSAGES
-- ============================================

CREATE TABLE IF NOT EXISTS emails (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    integration_id TEXT NOT NULL REFERENCES integrations(id),

    -- Email identifiers
    message_id TEXT NOT NULL,           -- Message-ID header (unique per email)
    thread_id TEXT,                     -- Gmail thread ID or In-Reply-To chain
    provider_id TEXT NOT NULL,          -- Provider-specific ID (Gmail ID, IMAP UID)

    -- Envelope data (not encrypted - needed for queries)
    from_address TEXT NOT NULL,         -- Sender email
    from_name TEXT,                     -- Sender display name
    to_addresses TEXT NOT NULL,         -- JSON array of recipients
    cc_addresses TEXT,                  -- JSON array
    bcc_addresses TEXT,                 -- JSON array

    -- Content (encrypted)
    subject TEXT NOT NULL,              -- encrypted
    body_text TEXT,                     -- encrypted, plain text version
    body_html TEXT,                     -- encrypted, HTML version
    snippet TEXT,                       -- encrypted, preview text

    -- Metadata
    received_at TEXT NOT NULL,          -- When email was received (from headers)
    internal_date TEXT NOT NULL,        -- Provider's internal date
    size_bytes INTEGER,
    has_attachments INTEGER DEFAULT 0,
    is_read INTEGER DEFAULT 0,
    is_starred INTEGER DEFAULT 0,
    is_important INTEGER DEFAULT 0,

    -- Labels/Folders
    labels TEXT,                        -- JSON array of labels/folders

    -- Headers (for advanced processing)
    headers_json TEXT,                  -- encrypted, full headers as JSON

    -- Threading
    in_reply_to TEXT,                   -- In-Reply-To header (message_id reference)
    references_list TEXT,               -- References header (JSON array)

    -- Classification
    ai_classification TEXT,             -- JSON classification result
    confidence_score REAL,
    classified_at TEXT,

    -- Promotion tracking
    promoted_to_type TEXT,              -- task, idea, commitment, etc.
    promoted_to_id TEXT,
    inbox_item_id TEXT REFERENCES inbox_items(id),

    -- Status
    status TEXT NOT NULL DEFAULT 'unprocessed',  -- unprocessed, processed, archived, deleted
    processed_at TEXT,

    -- Standard fields
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_emails_tenant_user ON emails(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_emails_integration ON emails(tenant_id, integration_id);
CREATE INDEX IF NOT EXISTS idx_emails_thread ON emails(tenant_id, thread_id);
CREATE INDEX IF NOT EXISTS idx_emails_from ON emails(tenant_id, from_address);
CREATE INDEX IF NOT EXISTS idx_emails_received ON emails(tenant_id, received_at);
CREATE INDEX IF NOT EXISTS idx_emails_status ON emails(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id);
CREATE INDEX IF NOT EXISTS idx_emails_provider_id ON emails(tenant_id, provider_id);

-- ============================================
-- EMAIL ATTACHMENTS
-- ============================================

CREATE TABLE IF NOT EXISTS email_attachments (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    email_id TEXT NOT NULL REFERENCES emails(id),

    -- Attachment metadata
    filename TEXT NOT NULL,             -- encrypted
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    content_id TEXT,                    -- For inline attachments (CID)
    is_inline INTEGER DEFAULT 0,

    -- Storage reference (R2 or external)
    storage_key TEXT,                   -- R2 object key
    storage_url TEXT,                   -- Signed URL or reference

    -- Provider reference (for lazy loading)
    provider_attachment_id TEXT,        -- Gmail attachment ID

    -- Extracted content (for searchable attachments)
    extracted_text TEXT,                -- encrypted, OCR/text extraction

    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_attachments_email ON email_attachments(email_id);
CREATE INDEX IF NOT EXISTS idx_attachments_tenant ON email_attachments(tenant_id);

-- ============================================
-- EMAIL SYNC STATE
-- ============================================

CREATE TABLE IF NOT EXISTS email_sync_state (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    integration_id TEXT NOT NULL REFERENCES integrations(id),

    -- Gmail-specific sync state
    history_id TEXT,                    -- Last Gmail historyId

    -- IMAP-specific sync state
    uidvalidity INTEGER,                -- IMAP UIDVALIDITY
    last_uid INTEGER,                   -- Last processed UID

    -- General sync state
    last_sync_at TEXT,
    next_sync_at TEXT,
    sync_status TEXT DEFAULT 'idle',    -- idle, syncing, error
    sync_error TEXT,

    -- Sync stats
    total_messages_synced INTEGER DEFAULT 0,
    last_message_received_at TEXT,

    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),

    UNIQUE(tenant_id, integration_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_state_integration ON email_sync_state(integration_id);

-- ============================================
-- EMAIL THREADS (Denormalized for Performance)
-- ============================================

CREATE TABLE IF NOT EXISTS email_threads (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id),

    thread_id TEXT NOT NULL,            -- Provider thread ID

    -- Thread summary
    subject TEXT NOT NULL,              -- encrypted, subject of first email
    snippet TEXT,                       -- encrypted, latest snippet
    participant_addresses TEXT,         -- JSON array of all participants

    -- Thread stats
    message_count INTEGER DEFAULT 1,
    unread_count INTEGER DEFAULT 0,
    has_attachments INTEGER DEFAULT 0,

    -- Dates
    first_message_at TEXT NOT NULL,
    last_message_at TEXT NOT NULL,

    -- Labels (aggregated from messages)
    labels TEXT,                        -- JSON array

    -- Classification (thread-level)
    ai_classification TEXT,
    confidence_score REAL,

    -- Promotion
    promoted_to_type TEXT,
    promoted_to_id TEXT,

    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT,

    UNIQUE(tenant_id, thread_id)
);

CREATE INDEX IF NOT EXISTS idx_threads_tenant_user ON email_threads(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_threads_last_message ON email_threads(tenant_id, last_message_at);
```

### Integration with Existing Schema

The `integrations` table already supports email:

```sql
-- Existing integrations table usage for email
INSERT INTO integrations (
    id, tenant_id, user_id,
    provider,           -- 'google' | 'microsoft' | 'imap'
    integration_type,   -- 'email'
    access_token,       -- encrypted OAuth access token
    refresh_token,      -- encrypted OAuth refresh token
    token_expires_at,
    account_email,      -- user's email address
    account_name,
    account_id,         -- Google user ID
    last_sync_at,
    sync_cursor,        -- Gmail historyId
    sync_status,
    sync_error,
    settings            -- JSON: { labels_to_sync: [...], auto_classify: true }
)
```

### TypeScript Types

```typescript
// Email types for src/types/index.ts

export interface Email extends BaseEntity {
  user_id: string;
  integration_id: string;

  // Identifiers
  message_id: string;
  thread_id: string | null;
  provider_id: string;

  // Envelope
  from_address: string;
  from_name: string | null;
  to_addresses: string; // JSON array
  cc_addresses: string | null;
  bcc_addresses: string | null;

  // Content (encrypted)
  subject: string;
  body_text: string | null;
  body_html: string | null;
  snippet: string | null;

  // Metadata
  received_at: string;
  internal_date: string;
  size_bytes: number | null;
  has_attachments: boolean;
  is_read: boolean;
  is_starred: boolean;
  is_important: boolean;

  // Labels
  labels: string | null; // JSON array

  // Headers
  headers_json: string | null; // encrypted

  // Threading
  in_reply_to: string | null;
  references_list: string | null; // JSON array

  // Classification
  ai_classification: string | null;
  confidence_score: number | null;
  classified_at: string | null;

  // Promotion
  promoted_to_type: string | null;
  promoted_to_id: string | null;
  inbox_item_id: string | null;

  // Status
  status: 'unprocessed' | 'processed' | 'archived' | 'deleted';
  processed_at: string | null;
}

export interface EmailAttachment extends Omit<BaseEntity, 'updated_at'> {
  email_id: string;
  filename: string; // encrypted
  mime_type: string;
  size_bytes: number;
  content_id: string | null;
  is_inline: boolean;
  storage_key: string | null;
  storage_url: string | null;
  provider_attachment_id: string | null;
  extracted_text: string | null; // encrypted
}

export interface EmailThread extends BaseEntity {
  user_id: string;
  thread_id: string;
  subject: string; // encrypted
  snippet: string | null; // encrypted
  participant_addresses: string; // JSON array
  message_count: number;
  unread_count: number;
  has_attachments: boolean;
  first_message_at: string;
  last_message_at: string;
  labels: string | null; // JSON array
  ai_classification: string | null;
  confidence_score: number | null;
  promoted_to_type: string | null;
  promoted_to_id: string | null;
}

export interface EmailSyncState {
  id: string;
  tenant_id: string;
  integration_id: string;
  history_id: string | null;
  uidvalidity: number | null;
  last_uid: number | null;
  last_sync_at: string | null;
  next_sync_at: string | null;
  sync_status: 'idle' | 'syncing' | 'error';
  sync_error: string | null;
  total_messages_synced: number;
  last_message_received_at: string | null;
  created_at: string;
  updated_at: string;
}

// Email classification extends existing ClassificationResult
export interface EmailClassificationResult extends ClassificationResult {
  email_specific: {
    action_required: boolean;
    response_deadline: string | null;
    sender_relationship: 'unknown' | 'contact' | 'colleague' | 'friend' | 'family' | 'service';
    email_category: 'personal' | 'work' | 'transactional' | 'newsletter' | 'spam' | 'promotional';
    sentiment: 'positive' | 'neutral' | 'negative' | 'urgent';
    extracted_commitments: Array<{
      direction: 'waiting_for' | 'owed_to';
      description: string;
      person: string;
      due_date: string | null;
    }>;
    extracted_events: Array<{
      title: string;
      date: string;
      time: string | null;
      location: string | null;
    }>;
    suggested_reply: string | null;
  };
}
```

---

## Ingestion Pipeline Architecture

### High-Level Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           EMAIL INGESTION PIPELINE                           │
└─────────────────────────────────────────────────────────────────────────────┘

     ┌─────────────────┐
     │  Gmail Pub/Sub  │─────┐
     │  Push Webhook   │     │
     └─────────────────┘     │
                             │     ┌──────────────────────────────────────────┐
     ┌─────────────────┐     │     │                                          │
     │  Gmail Polling  │─────┼────▶│         EmailManager Durable Object      │
     │  Cron Trigger   │     │     │                                          │
     └─────────────────┘     │     │  ┌────────────────────────────────────┐  │
                             │     │  │  1. Deduplicate (by message_id)    │  │
     ┌─────────────────┐     │     │  │  2. Fetch full message content     │  │
     │  Email Forward  │─────┘     │  │  3. Parse headers, body, attach    │  │
     │  (CF Email)     │           │  │  4. Encrypt sensitive fields       │  │
     └─────────────────┘           │  │  5. Store in D1                    │  │
                                   │  │  6. Queue for classification       │  │
                                   │  └────────────────────────────────────┘  │
                                   │                                          │
                                   │  State: sync cursors, rate limits        │
                                   │  WebSocket: real-time email updates      │
                                   └─────────────────┬────────────────────────┘
                                                     │
                                                     ▼
                              ┌───────────────────────────────────────────────┐
                              │            Classification Queue               │
                              │                                               │
                              │  Uses existing InboxManager classification   │
                              │  pipeline with email-specific prompt          │
                              └───────────────────────────────────────────────┘
                                                     │
                                                     ▼
                              ┌───────────────────────────────────────────────┐
                              │            AI Classification (DE)             │
                              │                                               │
                              │  - Determine type (task, event, FYI, etc.)   │
                              │  - Extract commitments                        │
                              │  - Identify action items                      │
                              │  - Suggest response                           │
                              └───────────────────────────────────────────────┘
                                                     │
                                                     ▼
                              ┌───────────────────────────────────────────────┐
                              │            Auto-Actions                       │
                              │                                               │
                              │  High confidence (≥80%):                      │
                              │  - Create task from action items              │
                              │  - Create commitment from requests            │
                              │  - Add event to calendar                      │
                              │  - Update thread classification               │
                              │                                               │
                              │  Low confidence: Create inbox_item for review │
                              └───────────────────────────────────────────────┘
```

### EmailManager Durable Object

```typescript
// src/durable-objects/EmailManager.ts

export class EmailManager extends DurableObject {
  private syncStates: Map<string, EmailSyncState> = new Map();
  private classificationQueue: Email[] = [];
  private rateLimits: Map<string, { count: number; resetAt: number }> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
  }

  // HTTP API
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case '/sync':
        return this.handleSync(request);
      case '/push':
        return this.handlePubSubPush(request);
      case '/process':
        return this.handleProcess(request);
      case '/status':
        return this.handleStatus(request);
      case '/ws':
        return this.handleWebSocket(request);
      default:
        return new Response('Not found', { status: 404 });
    }
  }

  // Sync emails for an integration
  async handleSync(request: Request): Promise<Response> {
    const { integration_id, full_sync } = await request.json();

    // Get integration details
    const integration = await this.getIntegration(integration_id);
    if (!integration) {
      return Response.json({ error: 'Integration not found' }, { status: 404 });
    }

    // Check rate limits
    if (this.isRateLimited(integration_id)) {
      return Response.json({ error: 'Rate limited' }, { status: 429 });
    }

    // Perform sync based on provider
    switch (integration.provider) {
      case 'google':
        return this.syncGmail(integration, full_sync);
      case 'microsoft':
        return this.syncOutlook(integration, full_sync);
      case 'imap':
        return this.syncImap(integration, full_sync);
      default:
        return Response.json({ error: 'Unknown provider' }, { status: 400 });
    }
  }

  // Handle Gmail Pub/Sub push notification
  async handlePubSubPush(request: Request): Promise<Response> {
    const message = await request.json();

    // Verify Pub/Sub message authenticity
    if (!this.verifyPubSubMessage(message)) {
      return new Response('Invalid message', { status: 400 });
    }

    // Decode the notification
    const data = JSON.parse(atob(message.message.data));
    const { emailAddress, historyId } = data;

    // Find the integration for this email
    const integration = await this.findIntegrationByEmail(emailAddress);
    if (!integration) {
      return new Response('OK'); // Silently ignore unknown emails
    }

    // Queue an incremental sync
    await this.queueSync(integration.id, historyId);

    return new Response('OK');
  }

  // Gmail sync implementation
  private async syncGmail(
    integration: Integration,
    fullSync: boolean
  ): Promise<Response> {
    const syncState = await this.getSyncState(integration.id);

    // Refresh token if needed
    const tokens = await this.refreshTokensIfNeeded(integration);

    // Determine sync strategy
    if (fullSync || !syncState?.history_id) {
      // Full sync - list all messages
      return this.fullGmailSync(integration, tokens);
    } else {
      // Incremental sync using history API
      return this.incrementalGmailSync(integration, tokens, syncState.history_id);
    }
  }

  private async fullGmailSync(
    integration: Integration,
    tokens: { access_token: string }
  ): Promise<Response> {
    const gmail = new GmailClient(tokens.access_token);

    let pageToken: string | undefined;
    let totalSynced = 0;
    const batchSize = 100;

    do {
      // List messages
      const list = await gmail.messages.list({
        maxResults: batchSize,
        pageToken,
        labelIds: ['INBOX'], // Configure which labels to sync
      });

      if (!list.messages) break;

      // Fetch full message content in batches
      const messages = await Promise.all(
        list.messages.map(m => gmail.messages.get(m.id, { format: 'full' }))
      );

      // Process and store messages
      for (const message of messages) {
        await this.processGmailMessage(integration, message);
        totalSynced++;
      }

      pageToken = list.nextPageToken;

      // Update sync state
      await this.updateSyncState(integration.id, {
        history_id: list.historyId,
        total_messages_synced: totalSynced,
        last_sync_at: new Date().toISOString(),
      });

    } while (pageToken);

    return Response.json({ synced: totalSynced });
  }

  private async processGmailMessage(
    integration: Integration,
    gmailMessage: GmailMessage
  ): Promise<Email> {
    // Parse headers
    const headers = this.parseHeaders(gmailMessage.payload.headers);

    // Extract body
    const { text, html } = this.extractBody(gmailMessage.payload);

    // Check for duplicates
    const existing = await this.findEmailByMessageId(
      integration.tenant_id,
      headers.messageId
    );
    if (existing) {
      return existing; // Already processed
    }

    // Create email record
    const email: Email = {
      id: crypto.randomUUID(),
      tenant_id: integration.tenant_id,
      user_id: integration.user_id,
      integration_id: integration.id,

      message_id: headers.messageId,
      thread_id: gmailMessage.threadId,
      provider_id: gmailMessage.id,

      from_address: headers.from.address,
      from_name: headers.from.name,
      to_addresses: JSON.stringify(headers.to),
      cc_addresses: headers.cc ? JSON.stringify(headers.cc) : null,
      bcc_addresses: headers.bcc ? JSON.stringify(headers.bcc) : null,

      subject: await this.encrypt(headers.subject),
      body_text: text ? await this.encrypt(text) : null,
      body_html: html ? await this.encrypt(html) : null,
      snippet: gmailMessage.snippet ? await this.encrypt(gmailMessage.snippet) : null,

      received_at: headers.date,
      internal_date: new Date(parseInt(gmailMessage.internalDate)).toISOString(),
      size_bytes: gmailMessage.sizeEstimate,
      has_attachments: this.hasAttachments(gmailMessage.payload),
      is_read: !gmailMessage.labelIds?.includes('UNREAD'),
      is_starred: gmailMessage.labelIds?.includes('STARRED') ?? false,
      is_important: gmailMessage.labelIds?.includes('IMPORTANT') ?? false,

      labels: JSON.stringify(gmailMessage.labelIds),
      headers_json: await this.encrypt(JSON.stringify(headers.raw)),

      in_reply_to: headers.inReplyTo,
      references_list: headers.references ? JSON.stringify(headers.references) : null,

      status: 'unprocessed',

      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    };

    // Store email
    await this.storeEmail(email);

    // Process attachments
    if (email.has_attachments) {
      await this.processAttachments(email, gmailMessage.payload.parts);
    }

    // Update thread
    await this.updateThread(email);

    // Queue for classification
    this.classificationQueue.push(email);

    // Notify via WebSocket
    this.notifyNewEmail(email);

    return email;
  }

  // Classification processing
  async processClassificationQueue(): Promise<void> {
    while (this.classificationQueue.length > 0) {
      const email = this.classificationQueue.shift()!;

      try {
        const classification = await this.classifyEmail(email);

        // Update email with classification
        await this.updateEmail(email.id, {
          ai_classification: JSON.stringify(classification),
          confidence_score: classification.confidence_score,
          classified_at: new Date().toISOString(),
          status: 'processed',
          processed_at: new Date().toISOString(),
        });

        // Auto-create items if high confidence
        if (classification.confidence_score >= 0.8) {
          await this.autoCreateItems(email, classification);
        } else {
          // Create inbox item for manual review
          await this.createInboxItem(email, classification);
        }

      } catch (error) {
        console.error(`Failed to classify email ${email.id}:`, error);
        // Leave in unprocessed state for retry
      }
    }
  }

  private async classifyEmail(email: Email): Promise<EmailClassificationResult> {
    // Decrypt content for classification
    const subject = await this.decrypt(email.subject);
    const body = email.body_text ? await this.decrypt(email.body_text) : '';

    // Build classification prompt
    const prompt = `Classify this email and extract actionable items:

From: ${email.from_name || email.from_address}
Subject: ${subject}
Date: ${email.received_at}

${body.substring(0, 4000)} // Limit for token efficiency

Respond in JSON with:
{
  "type": "task" | "event" | "idea" | "reference" | "someday",
  "domain": "work" | "personal" | "side_project" | "family" | "health",
  "title": "extracted action item or summary",
  "description": "key details",
  "urgency": 1-5,
  "importance": 1-5,
  "due_date": "ISO date if mentioned",
  "confidence_score": 0-1,
  "email_specific": {
    "action_required": boolean,
    "response_deadline": "ISO date if reply expected by",
    "sender_relationship": "unknown" | "contact" | "colleague" | "friend" | "family" | "service",
    "email_category": "personal" | "work" | "transactional" | "newsletter" | "spam" | "promotional",
    "sentiment": "positive" | "neutral" | "negative" | "urgent",
    "extracted_commitments": [{ "direction", "description", "person", "due_date" }],
    "extracted_events": [{ "title", "date", "time", "location" }],
    "suggested_reply": "brief suggested response if action_required"
  }
}`;

    // Call DE for classification
    const response = await this.env.DE.fetch('http://de/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: 'You are an email classification assistant. Respond only with valid JSON.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 1000,
        response_format: { type: 'json_object' }
      })
    });

    const result = await response.json();
    return JSON.parse(result.content);
  }

  private async autoCreateItems(
    email: Email,
    classification: EmailClassificationResult
  ): Promise<void> {
    // Create task if action required
    if (classification.type === 'task' || classification.email_specific.action_required) {
      await this.createTaskFromEmail(email, classification);
    }

    // Create commitments from extracted items
    for (const commitment of classification.email_specific.extracted_commitments) {
      await this.createCommitmentFromEmail(email, commitment);
    }

    // Create calendar events (future: integrate with calendar)
    for (const event of classification.email_specific.extracted_events) {
      // Store as task with calendar metadata for now
      await this.createEventTaskFromEmail(email, event);
    }
  }
}
```

---

## Security Considerations

### OAuth 2.0 Token Management

```typescript
// Token storage and refresh

interface OAuthTokens {
  access_token: string;     // encrypted in DB
  refresh_token: string;    // encrypted in DB
  expires_at: string;       // ISO timestamp
  token_type: string;
  scope: string;
}

// Token refresh flow
async function refreshGoogleTokens(integration: Integration): Promise<OAuthTokens> {
  const refreshToken = await decrypt(integration.refresh_token);

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    throw new Error('Token refresh failed');
  }

  const tokens = await response.json();

  // Update stored tokens
  await updateIntegration(integration.id, {
    access_token: await encrypt(tokens.access_token),
    refresh_token: tokens.refresh_token
      ? await encrypt(tokens.refresh_token)
      : integration.refresh_token,
    token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  });

  return tokens;
}
```

### Encryption Strategy

**Fields to encrypt:**
- `emails.subject`
- `emails.body_text`
- `emails.body_html`
- `emails.snippet`
- `emails.headers_json`
- `email_attachments.filename`
- `email_attachments.extracted_text`
- `email_threads.subject`
- `email_threads.snippet`

**Not encrypted (needed for queries):**
- `emails.from_address` - for sender filtering
- `emails.to_addresses` - for recipient filtering
- `emails.received_at` - for date queries
- `emails.message_id` - for deduplication
- `emails.thread_id` - for thread grouping
- `emails.labels` - for label filtering

### Rate Limiting

```typescript
// Gmail API quota management
const GMAIL_QUOTA = {
  messages_list: { perSecond: 10, perDay: 50000 },
  messages_get: { perSecond: 25, perDay: 100000 },
  history_list: { perSecond: 10, perDay: 50000 },
};

// Implement exponential backoff
async function withRateLimiting<T>(
  operation: () => Promise<T>,
  quotaKey: string,
  maxRetries = 5
): Promise<T> {
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      await waitForQuota(quotaKey);
      return await operation();
    } catch (error) {
      if (error.status === 429) {
        const backoff = Math.pow(2, attempt) * 1000;
        await sleep(backoff);
        attempt++;
      } else {
        throw error;
      }
    }
  }

  throw new Error('Rate limit exceeded after max retries');
}
```

### Pub/Sub Security

```typescript
// Verify Google Pub/Sub push messages
async function verifyPubSubMessage(request: Request): Promise<boolean> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return false;
  }

  const token = authHeader.slice(7);

  // Verify the token with Google
  const response = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${token}`
  );

  if (!response.ok) {
    return false;
  }

  const tokenInfo = await response.json();

  // Verify the audience matches our Pub/Sub subscription
  return tokenInfo.aud === env.PUBSUB_AUDIENCE;
}
```

---

## API Endpoints

### New Routes

```typescript
// src/routes/email.ts

import { Hono } from 'hono';
import { AppType } from '../types';

const email = new Hono<AppType>();

// List emails
email.get('/', async (c) => {
  const { status, from, thread_id, label, since, limit = 50, offset = 0 } = c.req.query();
  // Implementation
});

// Get single email
email.get('/:id', async (c) => {
  // Implementation
});

// Get email thread
email.get('/threads/:thread_id', async (c) => {
  // Implementation
});

// Mark email as read/unread
email.patch('/:id/read', async (c) => {
  // Implementation
});

// Archive email
email.post('/:id/archive', async (c) => {
  // Implementation
});

// Promote email to task/idea/commitment
email.post('/:id/promote', async (c) => {
  const { type, data } = await c.req.json();
  // Implementation
});

// Re-classify email
email.post('/:id/reclassify', async (c) => {
  // Implementation
});

// Get attachments for email
email.get('/:id/attachments', async (c) => {
  // Implementation
});

// Download attachment
email.get('/:id/attachments/:attachment_id', async (c) => {
  // Implementation
});

// Sync endpoints
email.post('/sync', async (c) => {
  const { integration_id, full_sync } = await c.req.json();
  // Trigger sync via EmailManager DO
});

email.get('/sync/status', async (c) => {
  const { integration_id } = c.req.query();
  // Get sync status
});

// Gmail Pub/Sub webhook (public endpoint)
email.post('/push/:integration_id', async (c) => {
  // Handle Pub/Sub push notification
});

export default email;
```

### MCP Tools

```typescript
// Additional MCP tools for email

// List emails
nexus_list_emails({
  status?: 'unprocessed' | 'processed' | 'archived',
  from?: string,
  since?: string,
  label?: string,
  limit?: number
})

// Get email details
nexus_get_email({ email_id: string })

// Get email thread
nexus_get_email_thread({ thread_id: string })

// Promote email to task
nexus_email_to_task({
  email_id: string,
  title?: string,
  due_date?: string,
  priority?: number,
  passphrase: string
})

// Trigger email sync
nexus_sync_email({
  integration_id?: string,
  full_sync?: boolean,
  passphrase: string
})

// Search emails
nexus_search_emails({
  query: string,
  from?: string,
  since?: string,
  limit?: number
})
```

---

## Cron Jobs

```toml
# wrangler.toml

[triggers]
crons = [
  "0 0 * * *",      # Daily at midnight - recurring tasks
  "*/15 * * * *",   # Every 15 min - task dispatcher
  "*/5 * * * *"     # Every 5 min - email sync (new)
]
```

```typescript
// Handle email sync cron
async function handleEmailSyncCron(env: Env): Promise<void> {
  // Get all active email integrations
  const integrations = await db
    .selectFrom('integrations')
    .where('integration_type', '=', 'email')
    .where('sync_status', '=', 'active')
    .where('deleted_at', 'is', null)
    .selectAll()
    .execute();

  // Sync each integration
  for (const integration of integrations) {
    const emailManagerId = env.EMAIL_MANAGER.idFromName(integration.tenant_id);
    const emailManager = env.EMAIL_MANAGER.get(emailManagerId);

    await emailManager.fetch('http://email-manager/sync', {
      method: 'POST',
      body: JSON.stringify({ integration_id: integration.id }),
    });
  }
}
```

---

## OAuth Setup Guide

### Google OAuth Setup

1. **Create Google Cloud Project**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Create new project or select existing
   - Enable Gmail API

2. **Configure OAuth Consent Screen**
   - Set app name, user support email
   - Add scopes:
     - `https://www.googleapis.com/auth/gmail.readonly`
     - `https://www.googleapis.com/auth/gmail.modify` (for marking read)
   - Add test users during development

3. **Create OAuth Credentials**
   - Create OAuth 2.0 Client ID
   - Application type: Web application
   - Add authorized redirect URI: `https://reauth.shiftaltcreate.com/callback/google`
   - Save Client ID and Secret

4. **Configure Pub/Sub (for push notifications)**
   - Create Pub/Sub topic: `gmail-notifications`
   - Create push subscription pointing to `https://nexus-mcp.solamp.workers.dev/api/email/push`
   - Grant Gmail API service account publish permissions

5. **Set Secrets**
   ```bash
   wrangler secret put GOOGLE_CLIENT_ID
   wrangler secret put GOOGLE_CLIENT_SECRET
   wrangler secret put PUBSUB_AUDIENCE
   ```

### OAuth Flow via reauth-ui

The existing `reauth-ui` service at `reauth.shiftaltcreate.com` can be extended:

```typescript
// POST /api/integrations/google/connect
// Initiates OAuth flow, redirects to Google

// GET /callback/google
// Handles OAuth callback, stores tokens in Nexus

// POST /api/integrations/:id/refresh
// Manually refresh tokens if needed
```

---

## Migration Plan

### Database Migration

```sql
-- migrations/003_add_email_tables.sql

-- Run schema additions from Data Model section above

-- Add foreign key to existing inbox_items table
ALTER TABLE inbox_items ADD COLUMN source_email_id TEXT REFERENCES emails(id);

-- Add email source types to inbox_items
-- source_type can now be: 'manual', 'voice', 'api', 'email'
```

### Environment Variables

```toml
# wrangler.toml additions

[vars]
GOOGLE_CLIENT_ID = "..."  # Set via secret

# Durable Objects
[durable_objects]
bindings = [
  { name = "EMAIL_MANAGER", class_name = "EmailManager" }
]

[[migrations]]
tag = "v3"
new_classes = ["EmailManager"]
```

---

## Summary

### Phase 1 Deliverables (MVP)
1. Email schema and migrations
2. Gmail polling sync via cron
3. Basic email parsing and storage
4. Email classification (extend existing classifier)
5. Email list/detail API endpoints
6. Manual email-to-task promotion

### Phase 2 Deliverables
1. Gmail Pub/Sub push notifications
2. EmailManager Durable Object
3. Thread management
4. Auto-create tasks from high-confidence emails
5. MCP tools for email access

### Phase 3 Deliverables
1. Cloudflare Email Workers (forwarding)
2. Attachment handling (R2 storage)
3. Email search
4. Thread-level classification

### Future Considerations
- IMAP support for non-Gmail providers
- Email drafting/sending via AI
- Calendar event extraction and creation
- Newsletter auto-unsubscribe
- Spam detection and filtering
