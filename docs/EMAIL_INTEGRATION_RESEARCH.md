# Email Integration Research: Gmail API, IMAP, and Webhooks

**Research Date:** December 30, 2025
**Reference:** 1b9703c7-f685-48bf-bc87-c3851647a7e0
**Related Idea:** a6972c62-7c6e-448f-a35e-2c3aaf3a91cd

---

## Executive Summary

This document evaluates three approaches for email ingestion: **Gmail API**, **IMAP**, and **webhook/push notifications**. For Nexus, the recommended approach is **Gmail API with Pub/Sub push notifications** as the primary method, with Gmail API polling as fallback.

| Approach | Latency | Complexity | Rate Limits | Best For |
|----------|---------|------------|-------------|----------|
| Gmail API + Pub/Sub | < 5 seconds | High | 250 units/user/sec | Real-time ingestion |
| Gmail API Polling | 1-5 minutes | Medium | 250 units/user/sec | Development/fallback |
| IMAP + OAuth2 | Varies | High | Same as API | Cross-provider support |
| Email Forwarding | < 30 seconds | Low | N/A | Simple setups |

---

## 1. Gmail API Integration

### 1.1 Authentication Requirements

**OAuth 2.0 is mandatory** for all Gmail API access.

| Requirement | Details |
|-------------|---------|
| Auth Protocol | OAuth 2.0 with refresh tokens |
| Scope Required | `https://mail.google.com/` (full access) or specific scopes |
| Token Lifetime | Access token: ~1 hour; Refresh token: indefinite |
| App Verification | Required for production (Google review process) |
| User Limit (Unverified) | 100 users lifetime per project |

**OAuth Scopes Available:**
```
gmail.readonly          - Read all messages and settings
gmail.modify            - Read, send, delete, manage labels
gmail.compose           - Create and send emails
gmail.send              - Send emails only
gmail.labels            - Manage labels
gmail.metadata          - View message metadata
https://mail.google.com/ - Full access (required for IMAP)
```

**Recommended for Nexus:** Start with `gmail.readonly` for email ingestion, add `gmail.modify` if we need to mark emails as read or apply labels.

### 1.2 Rate Limits and Quotas

**Daily Project Quota:** 1,000,000,000 quota units/day

| Operation | Units Consumed |
|-----------|---------------|
| **Messages** | |
| messages.list | 5 |
| messages.get | 5 |
| messages.send | 100 |
| messages.delete | 10 |
| messages.modify | 5 |
| messages.import | 25 |
| messages.insert | 25 |
| messages.batchDelete | 50 |
| messages.batchModify | 50 |
| messages.trash | 5 |
| messages.untrash | 5 |
| messages.attachments.get | 5 |
| **History & Watch** | |
| history.list | 2 |
| watch | 100 |
| stop | 50 |
| **Drafts** | |
| drafts.create | 10 |
| drafts.delete | 10 |
| drafts.get | 5 |
| drafts.list | 5 |
| drafts.send | 100 |
| drafts.update | 15 |
| **Threads** | |
| threads.get | 10 |
| threads.list | 10 |
| threads.modify | 10 |
| threads.delete | 20 |
| threads.trash | 10 |
| threads.untrash | 10 |
| **Labels** | |
| labels.create | 5 |
| labels.delete | 5 |
| labels.get | 1 |
| labels.list | 1 |
| labels.update | 5 |
| **Profile** | |
| getProfile | 1 |
| **Settings** | |
| settings.*.get | 1 |
| settings.*.list | 1 |
| settings.*.create (delegates, forwardingAddresses, sendAs) | 100 |
| settings.*.delete | 5 |
| settings.*.update | 5-100 (varies) |
| **Batch Request** | Sum of individual requests |

**Per-User Limits:**
- **15,000 quota units per user per minute** (more accurate current limit)
- **250 quota units per user per second** (moving average, allows bursts)
- **1,200,000 quota units per project per minute** (project-wide limit)
- Concurrent request limit per user
- Upload/download bandwidth limits (shared with IMAP)

**Error Handling:**
- HTTP 429: Rate limit exceeded (retry with exponential backoff)
- HTTP 403: Quota exceeded or permission denied
- Recommended: Stay around **150 units/sec** to avoid 429 errors

### 1.3 Integration Complexity

**Setup Steps:**
1. Create Google Cloud Project
2. Enable Gmail API
3. Configure OAuth consent screen
4. Create OAuth 2.0 credentials
5. Implement OAuth flow in application
6. Handle token refresh lifecycle
7. (For production) Submit app for Google verification

**Complexity Rating:** ⭐⭐⭐ Medium-High

**Key Challenges:**
- Token refresh management (access tokens expire hourly)
- Google app verification process (2-4 weeks typically)
- Handling quota errors gracefully
- Batch request optimization

### 1.4 Code Complexity Estimate

```typescript
// Core components needed:
interface GmailIntegration {
  // OAuth flow
  getAuthUrl(): string;
  exchangeCode(code: string): Promise<Tokens>;
  refreshToken(refreshToken: string): Promise<Tokens>;

  // Email operations
  listMessages(userId: string, query?: string): Promise<Message[]>;
  getMessage(userId: string, messageId: string): Promise<FullMessage>;
  getHistory(userId: string, startHistoryId: string): Promise<HistoryChange[]>;

  // Watch setup
  setupWatch(userId: string, topicName: string): Promise<WatchResponse>;
  renewWatch(userId: string): Promise<WatchResponse>;
}
```

**Estimated Lines of Code:** ~500-800 (excluding tests)

---

## 2. IMAP Integration

### 2.1 Authentication Requirements

**As of March 14, 2025, OAuth2 is mandatory** - basic username/password authentication (Less Secure Apps) is permanently disabled for Gmail. Google resumed final rollout on January 27, 2025.

| Requirement | Details |
|-------------|---------|
| Protocol | SASL XOAUTH2 |
| Scope | `https://mail.google.com/` |
| Server | imap.gmail.com:993 (SSL required) |
| Session Limit | ~24 hours with password, ~1 hour with OAuth |

**Alternative:** App Passwords (2FA accounts only, not recommended for production)

### 2.2 Rate Limits

IMAP shares bandwidth limits with Gmail API:
- Per-user upload/download bandwidth limits
- Connection limits per account
- No explicit quota units (bandwidth-based)

**IMAP-Specific Limits:**
- Max concurrent connections: **15 per account** (shared across all clients/devices)
- Max connections per 10 minutes: 10 new connections
- Session timeout: 24 hours (1 hour with OAuth)

**Connection Limit Errors:**
If connections exceed 15, Gmail returns "Too many simultaneous connections" error. Common causes:
- Multiple email clients across devices
- Third-party apps maintaining persistent connections
- Background sync processes

**Note:** As of January 2025, the "Enable IMAP" toggle is no longer available in Gmail settings - IMAP access is always enabled.

### 2.3 Integration Complexity

**Setup Steps:**
1. All OAuth steps from Gmail API (same requirements)
2. Implement IMAP client with XOAUTH2 SASL mechanism
3. Handle connection lifecycle
4. Parse IMAP responses (complex protocol)
5. Implement reconnection logic

**Complexity Rating:** ⭐⭐⭐⭐ High

**Key Challenges:**
- IMAP protocol complexity
- Persistent connections not suitable for serverless (Cloudflare Workers)
- Connection pooling and management
- IDLE command requires long-lived connections
- Token refresh during active sessions

### 2.4 Node.js IMAP Libraries

If IMAP is required, here are the available Node.js libraries:

| Library | API Style | Recommended For | Status |
|---------|-----------|-----------------|--------|
| **[ImapFlow](https://imapflow.com/)** | Promise/async-await | Modern projects, production use | ✅ Active, recommended |
| **[node-imap](https://github.com/mscdex/node-imap)** | Callbacks | Full control, legacy projects | ⚠️ Maintenance mode |
| **[imap-simple](https://www.npmjs.com/package/imap-simple)** | Promise wrapper | Quick prototypes | ⚠️ Limited functionality |
| **[EmailEngine](https://emailengine.app/)** | REST API | Enterprise, self-hosted | ✅ Active |

**ImapFlow Features:**
- TypeScript definitions included
- Automatic handling of IMAP extensions (X-GM-EXT-1 for Gmail labels)
- SASL PLAIN with authorization identity (authzid) for admin impersonation
- Battle-tested as foundation for EmailEngine

**Note:** For Cloudflare Workers, IMAP is not recommended due to persistent connection requirements.

### 2.5 Serverless Compatibility

**Problem:** IMAP IDLE (push) requires persistent TCP connections, which Cloudflare Workers don't support.

**Solutions:**
1. **Polling-based IMAP:** Connect, fetch, disconnect (inefficient)
2. **Bridge service:** Dedicated VM/container that maintains IMAP connections
3. **Use Gmail API instead:** Better serverless fit

**Recommendation:** Avoid IMAP for Cloudflare Workers deployment. If multi-provider support is needed, use a managed email service or bridge.

---

## 3. Webhook/Push Notifications

### 3.1 Gmail Pub/Sub Push

**Architecture:**
```
Gmail Inbox → Cloud Pub/Sub → HTTPS Push → Nexus Worker
```

**Requirements:**
| Requirement | Details |
|-------------|---------|
| Google Cloud Pub/Sub | Required (separate from Gmail API) |
| Public HTTPS Endpoint | Must be accessible from Google |
| Permission Grant | gmail-api-push@system.gserviceaccount.com needs Pub/Sub Publisher role |
| Watch Renewal | Must call `users.watch` every 7 days (recommend daily) |

### 3.2 Setup Steps

1. **Create Pub/Sub Topic:**
   ```
   projects/{project-id}/topics/gmail-notifications
   ```

2. **Create Subscription:**
   - Push subscription to your HTTPS endpoint
   - Or pull subscription for worker polling

3. **Grant Publisher Permission:**
   - Principal: `gmail-api-push@system.gserviceaccount.com`
   - Role: `roles/pubsub.publisher`

4. **Configure Gmail Watch:**
   ```typescript
   gmail.users.watch({
     userId: 'me',
     requestBody: {
       topicName: 'projects/{project}/topics/gmail-notifications',
       labelIds: ['INBOX'],  // Optional filter
     }
   });
   ```

5. **Handle Push Messages:**
   - Parse Pub/Sub message (contains historyId, not email content)
   - Call `history.list` to get actual changes
   - Fetch full message content

### 3.3 Push Notification Format

```json
{
  "message": {
    "data": "eyJlbWFpbEFkZHJlc3MiOiAidXNlckBleGFtcGxlLmNvbSIsICJoaXN0b3J5SWQiOiAiMTIzNDU2Nzg5In0=",
    "messageId": "1234567890",
    "publishTime": "2025-12-30T12:00:00.000Z"
  },
  "subscription": "projects/my-project/subscriptions/gmail-push"
}
// Decoded data:
{
  "emailAddress": "user@example.com",
  "historyId": "123456789"
}
```

**Important:** Push notifications contain only `historyId`, not email content. You must call the Gmail API to fetch actual messages.

### 3.4 Rate Limits and Costs

**Pub/Sub Pricing:**
| Resource | Cost |
|----------|------|
| First 10 GB/month | Free |
| Beyond 10 GB | $40/TiB |
| Message storage | $0.27/GiB-month |

**For Gmail notifications:** Typically free tier is sufficient (notifications are small metadata messages).

### 3.5 Integration Complexity

**Complexity Rating:** ⭐⭐⭐⭐ High (initial setup), ⭐⭐ Low (ongoing)

**Benefits:**
- Near real-time delivery (< 5 seconds typically)
- No polling needed
- Efficient quota usage
- Scalable to many users

**Challenges:**
- Additional Google Cloud dependency
- Watch renewal required every 7 days
- Must handle out-of-order notifications
- History sync can be complex

---

## 4. Microsoft Graph API (Outlook Alternative)

For users with Outlook/Microsoft 365 accounts, Microsoft Graph API provides similar functionality.

### 4.1 Comparison with Gmail API

| Aspect | Gmail API | Microsoft Graph API |
|--------|-----------|---------------------|
| **Authentication** | OAuth 2.0 | OAuth 2.0 |
| **Push Notifications** | Via Pub/Sub | Native webhooks (change notifications) |
| **Webhook Expiration** | 7 days | 4,230 minutes (~3 days) |
| **Rate Limits** | Quota units per method | Per-app and per-user throttling |
| **Integration** | Google Cloud ecosystem | Microsoft 365 ecosystem |
| **Best For** | Gmail/Google Workspace users | Outlook/Microsoft 365 users |

### 4.2 Key Differences

**Simpler Webhooks:** Microsoft Graph has native webhook support without requiring a separate Pub/Sub service.

**Subscription Limits:** Outlook subscriptions expire after ~3 days vs 7 days for Gmail.

**API Design:** Graph API uses a unified REST design across all Microsoft 365 services.

### 4.3 Unified Email Solutions

For multi-provider support, consider:
- **[EmailEngine](https://emailengine.app/)** - Self-hosted, REST API for IMAP/SMTP + Gmail API + Graph API
- **[Nylas](https://www.nylas.com/)** - Managed email/calendar API platform
- **[Unipile](https://www.unipile.com/)** - Unified messaging APIs

---

## 5. Comparison Matrix

| Aspect | Gmail API (Push) | Gmail API (Poll) | MS Graph API | IMAP | Email Forwarding |
|--------|------------------|------------------|--------------|------|------------------|
| **Latency** | < 5 sec | Polling interval | < 5 sec | Connection-dependent | < 30 sec |
| **Setup Complexity** | High | Medium | Medium-High | High | Low |
| **Maintenance** | Watch renewal (7d) | Cron management | Sub renewal (3d) | Connection management | None |
| **Serverless Fit** | Excellent | Good | Excellent | Poor | Excellent |
| **Provider Support** | Gmail only | Gmail only | Outlook only | Any IMAP | Any email |
| **Quota Usage** | Efficient | Higher | Throttled | N/A | None |
| **Real-time** | Yes | No | Yes | Yes (IDLE) | Near |
| **Dependencies** | Pub/Sub, OAuth | OAuth only | OAuth only | OAuth, IMAP client | None |

---

## 6. Recommendations for Nexus

### 6.1 Primary Approach: Gmail API + Pub/Sub

**Justification:**
- Best latency for AI processing
- Efficient quota usage
- Serverless compatible
- Full access to Gmail features (labels, threading)

**Implementation Priority:**
1. OAuth flow with token storage (encrypted in D1)
2. Pub/Sub endpoint handler
3. History sync logic
4. Message parsing and storage

### 6.2 Fallback: Gmail API Polling

**Use Cases:**
- Development and testing
- Users who can't complete OAuth
- Redundancy if Pub/Sub has issues

**Configuration:**
```typescript
// Cron trigger every 5 minutes
export default {
  scheduled(event, env, ctx) {
    ctx.waitUntil(pollGmailForAllUsers(env));
  }
};
```

### 6.3 Future: Email Forwarding Webhook

**For Users Without OAuth:**
- Generate unique forwarding address per user
- Parse incoming email via Cloudflare Email Workers
- Lower friction but less metadata access

### 6.4 Not Recommended: Direct IMAP

**Reason:** Poor fit for Cloudflare Workers architecture. If multi-provider support is required, consider:
- Managed email services (Nylas, EmailEngine)
- Bridge VM that maintains IMAP connections

---

## 7. Implementation Roadmap

### Phase 1: Core OAuth & Push (Week 1-2)
- [ ] OAuth consent screen setup
- [ ] Token exchange and storage
- [ ] Pub/Sub topic and subscription
- [ ] Watch configuration endpoint
- [ ] Basic push handler

### Phase 2: History Sync (Week 2-3)
- [ ] History list implementation
- [ ] Message fetch and parsing
- [ ] Attachment handling
- [ ] Thread linking

### Phase 3: Production Hardening (Week 3-4)
- [ ] Error handling and retries
- [ ] Watch renewal cron
- [ ] Quota monitoring
- [ ] Rate limit handling
- [ ] Google app verification submission

### Phase 4: Fallback & Alternatives (Week 4+)
- [ ] Polling fallback
- [ ] Email forwarding webhook (optional)
- [ ] Multi-account support

---

## 8. Security Considerations

### 8.1 Token Storage
- Encrypt refresh tokens at rest
- Use per-user encryption keys derived from user secrets
- Never log tokens

### 8.2 Pub/Sub Verification
- Validate Pub/Sub message signatures
- Verify `emailAddress` matches expected user
- Rate limit push endpoint

### 8.3 Scope Minimization
- Request only necessary scopes
- Consider `gmail.readonly` for ingestion-only use case

### 8.4 App Verification
- Required for > 100 users
- Privacy policy and terms of service required
- Security assessment may be required for sensitive scopes

---

## 9. Personal Gmail vs Google Workspace

### 9.1 Key Differences

| Aspect | Personal Gmail (@gmail.com) | Google Workspace |
|--------|----------------------------|------------------|
| **Service Account Access** | Not supported | Supported via domain-wide delegation |
| **Domain-Wide Delegation** | N/A | Available for admins |
| **Authentication** | User OAuth consent required | Can impersonate users via service account |
| **Unverified App Limit** | 100 users per project (lifetime) | Same per external domain |
| **Admin Controls** | None | Full control over API access |

### 9.2 Implications for Nexus

**Personal Gmail accounts** (most likely target):
- Each user must complete OAuth consent flow
- Tokens must be securely stored and refreshed
- No server-to-server authentication option
- Must go through Google app verification for production

**Google Workspace accounts** (optional enterprise support):
- Could use service account with domain-wide delegation
- Admin grants access for all domain users
- More suitable for organizational deployments
- Requires Workspace admin configuration

### 9.3 Recommended Approach

For Nexus targeting personal Gmail:
1. Implement standard OAuth 2.0 flow with user consent
2. Store encrypted refresh tokens per user
3. Handle token refresh transparently
4. Plan for Google app verification process
5. Consider separate Workspace integration path for enterprise users

---

## 10. Sources

### Gmail API
- [Gmail API Quotas and Limits](https://developers.google.com/workspace/gmail/api/reference/quota)
- [Gmail API Error Handling](https://developers.google.com/workspace/gmail/api/guides/handle-errors)
- [Gmail API Push Notifications](https://developers.google.com/workspace/gmail/api/guides/push)
- [OAuth Application Rate Limits](https://support.google.com/cloud/answer/9028764?hl=en)

### IMAP/OAuth
- [Gmail XOAUTH2 Mechanism](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol)
- [IMAP, POP, and SMTP](https://developers.google.com/workspace/gmail/imap/imap-smtp)
- [Transition from Less Secure Apps](https://support.google.com/a/answer/14114704?hl=en)
- [Setting Up Gmail OAuth2 for IMAP](https://docs.emailengine.app/setting-up-gmail-oauth2-for-imap-api/)

### Pub/Sub
- [Cloud Pub/Sub Pricing](https://cloud.google.com/pubsub/pricing)
- [Push Subscriptions](https://docs.cloud.google.com/pubsub/docs/push)
- [Configuring Pub/Sub for Gmail Webhooks](https://docs.aurinko.io/unified-apis/webhooks-api/configuring-pub-sub-for-gmail-api-webhooks)

### IMAP Libraries
- [ImapFlow Documentation](https://imapflow.com/)
- [node-imap GitHub](https://github.com/mscdex/node-imap)
- [imap-simple npm](https://www.npmjs.com/package/imap-simple)
- [EmailEngine Email API](https://emailengine.app/)

### Microsoft Graph API
- [Outlook Mail API Overview](https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview?view=graph-rest-1.0)
- [Unipile Outlook API Integration](https://www.unipile.com/integrate-and-retrieve-emails-from-outlook-api/)

### Comparisons
- [Gmail API vs IMAP](https://www.gmass.co/blog/gmail-api-vs-imap/)
- [Moving to the Gmail API (Mixmax)](https://www.mixmax.com/engineering/moving-to-the-gmail-api)
- [Best Nylas Alternatives for Email APIs 2025](https://klamp.ai/blog/best-nylas-alternatives-for-email-calendar-and-contact-apis)
