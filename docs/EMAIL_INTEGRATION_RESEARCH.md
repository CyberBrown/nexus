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
| messages.list | 5 |
| messages.get (metadata) | 5 |
| messages.get (full) | 5 |
| messages.send | 100 |
| history.list | 2 |
| users.watch | 100 |
| Batch request | Sum of individual requests |

**Per-User Limits:**
- **250 quota units per user per second** (moving average, allows bursts)
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

**As of May 1, 2025, OAuth2 is required** - basic username/password authentication is disabled for Gmail.

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
- Max concurrent connections: 15 per account
- Max connections per 10 minutes: 10 new connections
- Session timeout: 24 hours (1 hour with OAuth)

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

### 2.4 Serverless Compatibility

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

## 4. Comparison Matrix

| Aspect | Gmail API (Push) | Gmail API (Poll) | IMAP | Email Forwarding |
|--------|------------------|------------------|------|------------------|
| **Latency** | < 5 sec | Polling interval | Connection-dependent | < 30 sec |
| **Setup Complexity** | High | Medium | High | Low |
| **Maintenance** | Watch renewal | Cron management | Connection management | None |
| **Serverless Fit** | Excellent | Good | Poor | Excellent |
| **Multi-Provider** | Gmail only | Gmail only | Any IMAP server | Any email |
| **Quota Usage** | Efficient | Higher | N/A | None |
| **Real-time** | Yes | No | Yes (IDLE) | Near |
| **Dependencies** | Pub/Sub, OAuth | OAuth only | OAuth, IMAP client | None |

---

## 5. Recommendations for Nexus

### 5.1 Primary Approach: Gmail API + Pub/Sub

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

### 5.2 Fallback: Gmail API Polling

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

### 5.3 Future: Email Forwarding Webhook

**For Users Without OAuth:**
- Generate unique forwarding address per user
- Parse incoming email via Cloudflare Email Workers
- Lower friction but less metadata access

### 5.4 Not Recommended: Direct IMAP

**Reason:** Poor fit for Cloudflare Workers architecture. If multi-provider support is required, consider:
- Managed email services (Nylas, EmailEngine)
- Bridge VM that maintains IMAP connections

---

## 6. Implementation Roadmap

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

## 7. Security Considerations

### 7.1 Token Storage
- Encrypt refresh tokens at rest
- Use per-user encryption keys derived from user secrets
- Never log tokens

### 7.2 Pub/Sub Verification
- Validate Pub/Sub message signatures
- Verify `emailAddress` matches expected user
- Rate limit push endpoint

### 7.3 Scope Minimization
- Request only necessary scopes
- Consider `gmail.readonly` for ingestion-only use case

### 7.4 App Verification
- Required for > 100 users
- Privacy policy and terms of service required
- Security assessment may be required for sensitive scopes

---

## 8. Sources

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

### Comparisons
- [Gmail API vs IMAP](https://www.gmass.co/blog/gmail-api-vs-imap/)
- [Moving to the Gmail API (Mixmax)](https://www.mixmax.com/engineering/moving-to-the-gmail-api)
