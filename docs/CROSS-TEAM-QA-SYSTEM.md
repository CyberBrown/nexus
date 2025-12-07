# Cross-Team Q&A System

> **Purpose**: Formal system for asking and answering questions between teams
> **Version**: 1.0.0
> **Status**: Active

---

## Overview

A structured Q&A system to prevent information loss and ensure timely responses between teams (Nexus, DE, Mnemo, Chris).

**Key Features**:
- Questions directed to specific teams
- Tracked in D1 database + markdown board
- Integrated into startup/wrap-up routines
- Accessible via API and MCP tool
- Priority levels and status tracking

---

## Database Schema

```sql
-- Cross-team Q&A table
CREATE TABLE IF NOT EXISTS cross_team_qa (
  id TEXT PRIMARY KEY,

  -- Question metadata
  asked_by TEXT NOT NULL,           -- 'nexus', 'de', 'mnemo', 'chris'
  asked_to TEXT NOT NULL,           -- 'nexus', 'de', 'mnemo', 'chris'
  category TEXT NOT NULL,           -- 'integration', 'architecture', 'cost', 'timeline', 'technical'
  priority TEXT NOT NULL DEFAULT 'medium',  -- 'critical', 'high', 'medium', 'low'

  -- Question content
  question_title TEXT NOT NULL,
  question_body TEXT NOT NULL,
  context TEXT,                     -- Optional: link to doc, PR, issue

  -- Answer
  answer_body TEXT,
  answered_by TEXT,
  answered_at TEXT,

  -- Status
  status TEXT NOT NULL DEFAULT 'open',  -- 'open', 'answered', 'closed', 'blocked'
  resolution_notes TEXT,

  -- Tracking
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- References
  parent_question_id TEXT,          -- For follow-up questions
  related_questions TEXT            -- JSON array of related IDs
);

-- Indexes
CREATE INDEX idx_qa_asked_to ON cross_team_qa(asked_to, status);
CREATE INDEX idx_qa_asked_by ON cross_team_qa(asked_by, status);
CREATE INDEX idx_qa_priority ON cross_team_qa(priority, status);
CREATE INDEX idx_qa_created ON cross_team_qa(created_at);
```

---

## Q&A Board (Markdown Format)

**Location**: `/home/chris/ecosystem/CROSS-TEAM-QA-BOARD.md`

```markdown
# Cross-Team Q&A Board

Last Updated: 2025-12-05 12:00 UTC

---

## 🔴 Critical Priority (Response Needed ASAP)

### [Q-001] API Contract for Tier 2 Escalation
**From**: Nexus → **To**: DE
**Category**: Integration
**Status**: 🟡 Open
**Asked**: 2025-12-05

**Question**: Does the proposed Tier 2 request/response format work for DE?

**Context**: [Nexus Roadmap v0.2](#link)

**Expected Response Format**:
```typescript
{
  action: 'auto-execute | notify | escalate',
  priority: 1 | 2 | 3,
  reasoning: 'string'
}
```

**Answer**: _Waiting for DE response_

---

## 🟠 High Priority (Response Needed Soon)

### [Q-002] Webhook Registration Flow
**From**: Nexus → **To**: Mnemo
**Category**: Technical
**Status**: 🟡 Open
**Asked**: 2025-12-05

**Question**: How does Nexus register webhook URL with Mnemo?

**Options**:
A. At service startup (auto-register)
B. Manual configuration (admin panel)
C. API call (programmatic registration)

**Answer**: _Waiting for Mnemo response_

---

## 🟢 Medium Priority (Response Helpful)

### [Q-003] Cache Alias Length Limit
**From**: Nexus → **To**: Mnemo
**Category**: Technical
**Status**: 🟢 Answered
**Asked**: 2025-12-05
**Answered**: 2025-12-05 by Mnemo

**Question**: Is there a max length for cache aliases?

**Answer**: Yes, 128 characters max. Recommend staying under 100 chars for readability.

**Resolution**: ✅ Implemented in Nexus cache naming helper

---

## ⚪ Low Priority (FYI / Future)

### [Q-004] Frontend Framework Recommendation
**From**: Bridge → **To**: Chris
**Category**: Architecture
**Status**: 🟡 Open
**Asked**: 2025-12-05

**Question**: Should we use React or SvelteKit for Bridge UI?

**Context**: Need to decide before Phase 1 implementation

**Answer**: _Waiting for Chris decision_

---

## 📋 Closed Questions (Last 30 Days)

### [Q-000] Multi-Account OAuth Pattern
**From**: Nexus → **To**: Mnemo
**Status**: ✅ Closed
**Resolution**: Documented in security guide, using workers-oauth-provider

---
```

---

## Startup Routine: Check Q&A

**When**: At the start of every Claude Code session or team work session

### Automated Check (via MCP Tool)

```typescript
// Check for answers to your questions
const myQuestions = await qa.getQuestions({
  asked_by: 'nexus',
  status: 'answered',
  unread: true  // New answers since last check
});

if (myQuestions.length > 0) {
  console.log(`📬 You have ${myQuestions.length} new answer(s)!`);

  for (const q of myQuestions) {
    console.log(`
[${q.id}] ${q.question_title}
Answer from ${q.answered_by}: ${q.answer_body}
Link: ${q.context}
    `);
  }

  // Mark as read
  await qa.markAsRead(myQuestions.map(q => q.id));
}

// Check for questions directed to you
const questionsForMe = await qa.getQuestions({
  asked_to: 'nexus',
  status: 'open',
  priority: ['critical', 'high']
});

if (questionsForMe.length > 0) {
  console.log(`⚠️ You have ${questionsForMe.length} open question(s) to answer!`);

  for (const q of questionsForMe) {
    console.log(`
[${q.id}] ${q.question_title} (${q.priority} priority)
From: ${q.asked_by}
Question: ${q.question_body}
Context: ${q.context}
    `);
  }
}
```

### Manual Check (Markdown Board)

```bash
# Read the Q&A board
cat /home/chris/ecosystem/CROSS-TEAM-QA-BOARD.md

# Or use grep to filter
grep -A 10 "To: nexus" /home/chris/ecosystem/CROSS-TEAM-QA-BOARD.md
```

---

## Wrap-Up Routine: Ask Questions

**When**: At the end of every work session, before wrapping up

### Checklist

Before ending session, ask yourself:
- [ ] **Did I encounter blockers?** → Ask the team that owns it
- [ ] **Did I make assumptions?** → Ask for confirmation
- [ ] **Do I need clarification?** → Ask now, not later
- [ ] **Did I discover gaps in docs?** → Ask for updates
- [ ] **Will next phase need input?** → Ask proactively

### Automated Question Creation (via MCP Tool)

```typescript
// Create a new question
await qa.askQuestion({
  asked_by: 'nexus',
  asked_to: 'de',
  category: 'integration',
  priority: 'high',
  question_title: 'API rate limits for Tier 2 requests',
  question_body: `
    How many Tier 2 requests can Nexus send to DE per minute?

    Context: During peak load (100 emails/minute), Nexus may escalate
    20 emails to Tier 2 simultaneously.

    Should we implement request batching or throttling?
  `,
  context: 'https://github.com/org/nexus/issues/42'
});
```

### Manual Question Creation (Markdown Board)

```markdown
## 🟠 High Priority

### [Q-NEW] Your Question Title
**From**: Nexus → **To**: DE
**Category**: Integration
**Status**: 🟡 Open
**Asked**: 2025-12-05

**Question**: Your question here...

**Context**: Link to relevant docs/PRs

**Answer**: _Waiting for DE response_
```

Then commit and push to shared repo.

---

## Priority Levels

| Priority | Icon | Response Time Target | Use When |
|----------|------|---------------------|----------|
| **Critical** | 🔴 | Same day | Blocks current work, production issue |
| **High** | 🟠 | 1-2 days | Needed for next phase, integration blocker |
| **Medium** | 🟢 | 3-5 days | Helpful for optimization, clarification |
| **Low** | ⚪ | 1-2 weeks | Nice to have, future planning |

**Note**: These are targets, not commitments. Focus on phases, not timelines.

---

## Question Categories

| Category | Description | Examples |
|----------|-------------|----------|
| **integration** | How services connect | API contracts, data formats, auth |
| **architecture** | System design decisions | Tier 1/2 split, memory tiers, service boundaries |
| **cost** | Billing and attribution | Rate limits, cost tracking, per-tenant billing |
| **timeline** | Dependencies and sequencing | "After X, we can start Y" |
| **technical** | Implementation details | Data schemas, error codes, testing |
| **process** | Workflow and collaboration | Code review, deployment, Q&A system itself |

---

## Status Definitions

| Status | Meaning | Next Action |
|--------|---------|-------------|
| **🟡 Open** | Question asked, awaiting answer | Assigned team should answer |
| **🟢 Answered** | Answer provided, questioner should review | Questioner marks as closed or asks follow-up |
| **✅ Closed** | Answer accepted, question resolved | Archive, no further action |
| **🔴 Blocked** | Cannot answer yet, waiting on something else | Document blocker, revisit later |

---

## API Endpoints (for MCP Tool)

```typescript
interface QAService {
  // Query questions
  getQuestions(filter: {
    asked_by?: string;
    asked_to?: string;
    status?: 'open' | 'answered' | 'closed' | 'blocked';
    priority?: string[];
    category?: string;
    unread?: boolean;
  }): Promise<Question[]>;

  // Ask question
  askQuestion(question: {
    asked_by: string;
    asked_to: string;
    category: string;
    priority: string;
    question_title: string;
    question_body: string;
    context?: string;
  }): Promise<string>;  // Returns question ID

  // Answer question
  answerQuestion(questionId: string, answer: {
    answered_by: string;
    answer_body: string;
    resolution_notes?: string;
  }): Promise<void>;

  // Update status
  updateStatus(questionId: string, status: string): Promise<void>;

  // Mark as read
  markAsRead(questionIds: string[]): Promise<void>;

  // Add follow-up
  addFollowUp(parentQuestionId: string, followUp: {
    asked_by: string;
    question_body: string;
  }): Promise<string>;
}
```

---

## Implementation Plan

### Phase 1: Database + Markdown Board
- [ ] Create D1 table in shared ecosystem database
- [ ] Create `/home/chris/ecosystem/CROSS-TEAM-QA-BOARD.md`
- [ ] Add seed questions (existing 7 from Nexus, 8 from DE)
- [ ] Document access pattern (manual for now)

### Phase 2: Simple API
- [ ] Create REST API for Q&A CRUD operations
- [ ] Add authentication (service tokens)
- [ ] Deploy to Workers endpoint

### Phase 3: MCP Tool
- [ ] Create MCP tool for Q&A access
- [ ] Add to `mcp__developer-guides` or create `mcp__cross-team-qa`
- [ ] Integrate with Claude Code startup/wrap-up

### Phase 4: Automation
- [ ] Auto-generate markdown board from D1
- [ ] Slack/email notifications for new questions
- [ ] Dashboard for Q&A analytics

---

## Usage Examples

### Scenario 1: Nexus Encounters Integration Blocker

**During work**:
```typescript
// Nexus discovers DE doesn't have rate limit info
console.log('🚧 Blocker: Need to know DE rate limits before implementing batching');
```

**Wrap-up routine**:
```typescript
await qa.askQuestion({
  asked_by: 'nexus',
  asked_to: 'de',
  category: 'integration',
  priority: 'high',
  question_title: 'API rate limits for Tier 2 requests',
  question_body: 'How many requests/minute can Nexus send to DE?',
  context: 'Needed for Phase 2 implementation'
});
```

**Next session (DE team)**:
```typescript
// DE startup routine
const questions = await qa.getQuestions({ asked_to: 'de', status: 'open' });
// Shows: [Q-042] API rate limits...

// DE answers
await qa.answerQuestion('Q-042', {
  answered_by: 'de',
  answer_body: 'Rate limit: 1000 requests/minute per service. No batching needed.'
});
```

**Next session (Nexus team)**:
```typescript
// Nexus startup routine
const answers = await qa.getQuestions({ asked_by: 'nexus', status: 'answered', unread: true });
// Shows: [Q-042] Answer from DE: 1000 requests/minute...

// Nexus closes question
await qa.updateStatus('Q-042', 'closed');
```

---

### Scenario 2: Proactive Question Before Starting Phase

**Before Phase 2**:
```typescript
// Nexus wrap-up after Phase 1
await qa.askQuestion({
  asked_by: 'nexus',
  asked_to: 'mnemo',
  category: 'integration',
  priority: 'high',
  question_title: 'Webhook registration flow for Phase 2',
  question_body: 'Need to know registration flow before implementing webhook handler',
  context: 'Blocks Phase 2 webhook implementation'
});
```

**Result**: Question answered before Phase 2 starts, no blocker.

---

## Best Practices

### DO ✅
- **Ask questions early** - Don't wait until blocked
- **Be specific** - Provide context and examples
- **Link to docs** - Include references to relevant documentation
- **Check Q&A daily** - Make it part of startup routine
- **Answer promptly** - Especially critical/high priority questions
- **Close when done** - Mark questions as closed after answer accepted

### DON'T ❌
- **Don't assume** - If unclear, ask
- **Don't ask in chat** - Use Q&A system for discoverability
- **Don't leave questions open** - Close or ask follow-up
- **Don't skip wrap-up** - Always check for new questions before ending session
- **Don't ignore priority** - Critical questions need same-day response

---

## Integration with Existing Processes

### GitHub PRs
- Link Q&A IDs in PR descriptions: "Resolves Q-042"
- Add "Blocks: Q-055" if PR is waiting on answer

### Documentation
- Reference Q&A in CLAUDE.md: "See Q-042 for rate limit details"
- Update docs when questions are answered

### Roadmaps
- Add "Blocked by Q-042" to phase dependencies
- Update when questions are answered

---

## Metrics and Analytics

Track Q&A effectiveness:
- **Response time** by priority level
- **Questions per team** (who asks most, who answers most)
- **Category distribution** (most common question types)
- **Resolution rate** (% of questions answered)
- **Blocker impact** (how many phases blocked by unanswered questions)

---

## Questions About This System?

Use the Q&A system to ask about the Q&A system! 😄

**Example**:
```typescript
await qa.askQuestion({
  asked_by: 'nexus',
  asked_to: 'chris',
  category: 'process',
  priority: 'medium',
  question_title: 'How do we handle questions that need group discussion?',
  question_body: 'Some questions might need input from multiple teams. How should we handle that?'
});
```

---

**Version**: 1.0.0
**Last Updated**: 2025-12-05
**Owner**: Ecosystem (all teams)
**Status**: Active - currently using markdown board, API/MCP tool in Phase 2
