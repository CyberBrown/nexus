# Mnemo Team: New Cross-Team Q&A System

**Date**: 2025-12-05
**From**: Nexus Team
**Purpose**: Introduction to formal Q&A process

---

## 🎯 What's New

We've created a **Cross-Team Q&A System** to formalize questions and answers between teams. This replaces ad-hoc questions in conversation with a structured, trackable system.

**Benefits**:
- ✅ Questions don't get lost
- ✅ Answers are discoverable by all teams
- ✅ Priority levels ensure timely responses
- ✅ Integrated into startup/wrap-up routines
- ✅ Links to relevant documentation

---

## 📄 Documentation

**Full System Documentation**: [CROSS-TEAM-QA-SYSTEM.md](/home/chris/nexus/docs/CROSS-TEAM-QA-SYSTEM.md)

**Q&A Board**: [CROSS-TEAM-QA-BOARD.md](/home/chris/nexus/docs/CROSS-TEAM-QA-BOARD.md)

---

## ❓ Current Questions for Mnemo (7 medium-priority)

Nexus has 7 operational questions on the Q&A board that need Mnemo team's answers:

1. **[Q-009] Webhook Registration Flow** - How does Nexus register webhook URL? (startup vs manual vs API)
2. **[Q-010] HMAC Secret Management** - How is webhook secret shared between services?
3. **[Q-011] Webhook Delivery & Retries** - What happens if Nexus is down? Retry logic?
4. **[Q-012] API Rate Limiting** - Any rate limits on Mnemo API calls?
5. **[Q-013] Error Code List** - What error codes should Nexus handle?
6. **[Q-014] Cache Alias Length Limit** - Max characters for cache aliases?
7. **[Q-015] Testing & Development Environment** - Dev/staging environment available?

**Where to find them**: [CROSS-TEAM-QA-BOARD.md](/home/chris/nexus/docs/CROSS-TEAM-QA-BOARD.md) (search for "To: Mnemo")

---

## 📋 How to Use the Q&A System

### At Session Startup (Check Q&A Board)

**Every time you start working on Mnemo**, check for:
1. **Questions directed to you** (status: 🟡 Open, To: Mnemo)
2. **Answers to your questions** (asked by Mnemo, status: 🟢 Answered)

```bash
# View questions for you
grep -A 10 "To: Mnemo" /home/chris/nexus/docs/CROSS-TEAM-QA-BOARD.md

# View answers to your questions
grep -A 10 "From: Mnemo" /home/chris/nexus/docs/CROSS-TEAM-QA-BOARD.md
```

### How to Answer Questions

1. Open [CROSS-TEAM-QA-BOARD.md](/home/chris/nexus/docs/CROSS-TEAM-QA-BOARD.md)
2. Find the question (e.g., [Q-009])
3. Replace `_Waiting for Mnemo response_` with your answer
4. Update status from `🟡 Open` to `🟢 Answered`
5. Add your name: `**Answered**: 2025-12-05 by Mnemo`
6. Commit and push (or notify Nexus team)

**Example**:
```markdown
### [Q-014] Cache Alias Length Limit
**From**: Nexus → **To**: Mnemo
**Category**: Technical
**Status**: 🟢 Answered  ← Change from 🟡 Open
**Asked**: 2025-12-05
**Answered**: 2025-12-05 by Mnemo  ← Add this line

**Question**: Is there a max length for cache aliases?

**Answer**: Yes, 128 characters max. Recommend staying under 100 chars for readability. Longer aliases will be truncated with a warning.  ← Add your answer here

**Resolution**: ✅ Documented in Mnemo API guide  ← Add resolution if applicable
```

### At Session Wrap-Up (Ask New Questions)

**Before ending your session**, check if you have new questions for other teams:

- Blocked by something in Nexus or DE?
- Need clarification on integration details?
- Discovered gaps in documentation?
- Need decisions from Chris?

**If yes**, add to the Q&A board:

```markdown
### [Q-NEW] Your Question Title
**From**: Mnemo → **To**: Nexus (or DE, Chris)
**Category**: Integration (or Architecture, Cost, Technical, Process)
**Status**: 🟡 Open
**Priority**: 🟠 High (or 🔴 Critical, 🟢 Medium, ⚪ Low)
**Asked**: 2025-12-05

**Question**: Your question here...

**Context**: Link to relevant docs, PRs, or issues

**Answer**: _Waiting for [team] response_
```

---

## 🎯 Priority Levels

| Priority | Icon | Response Time Target | Use When |
|----------|------|---------------------|----------|
| **Critical** | 🔴 | Same day | Blocks current work, production issue |
| **High** | 🟠 | 1-2 days | Needed for next phase, integration blocker |
| **Medium** | 🟢 | 3-5 days | Helpful for optimization, clarification |
| **Low** | ⚪ | 1-2 weeks | Nice to have, future planning |

**Note**: These are targets, not commitments. We plan in phases, not timelines.

---

## 📝 Example Workflow

### Scenario: Mnemo Discovers Integration Issue

**During work**:
```typescript
// Mnemo team discovers: Nexus is sending 1000 emails in one load() call
console.log('⚠️ Issue: Nexus loading 1000 emails exceeds 900k token limit');
```

**Wrap-up routine**:
```markdown
### [Q-016] Max Items Per Context Load
**From**: Mnemo → **To**: Nexus
**Category**: Technical
**Status**: 🟡 Open
**Priority**: 🟠 High
**Asked**: 2025-12-05

**Question**: What's a reasonable max items per context_load() call?

**Details**: Discovered Nexus trying to load 1000 emails in one call, exceeding 900k token limit. Should we:
A. Document max items per load (e.g., 100 emails max)
B. Implement auto-batching in Mnemo
C. Return error and let Nexus handle batching

**Context**: Blocks Phase 2 email integration testing

**Answer**: _Waiting for Nexus response_
```

**Next session (Nexus team)**:
```bash
# Nexus startup routine shows new question
grep "From: Mnemo" CROSS-TEAM-QA-BOARD.md
# Shows [Q-016] Max Items Per Context Load

# Nexus answers
```

```markdown
**Answer**: Option C - return error, Nexus will batch. We'll limit to 50 emails per load() call (~50KB each = 2.5MB total, well under token limit).

**Status**: 🟢 Answered
**Answered**: 2025-12-05 by Nexus
```

**Result**: Issue resolved before blocker, documented for future reference.

---

## 🔄 Integration with Existing Workflow

### In Your CLAUDE.md

Add startup/wrap-up reminders:

```markdown
## Session Startup Routine

1. Check Q&A board for questions directed to Mnemo
2. Check for answers to questions you asked
3. [existing startup tasks...]

## Session Wrap-Up Routine

1. [existing wrap-up tasks...]
2. Check if you have new questions for other teams
3. Add questions to Q&A board if needed
```

### In GitHub PRs

Link Q&A IDs when relevant:
```markdown
## Summary
Implements webhook system for cache eviction notifications.

**Resolves**: Q-009 (Webhook Registration Flow)
**Related**: Q-010 (HMAC Secret Management)
```

### In Documentation

Reference Q&A when documenting decisions:
```markdown
## Webhook Configuration

Webhook registration uses API call pattern (Option C from Q-009).
See Q&A board for full discussion.
```

---

## 📊 Current Q&A Board Statistics

- **Total Open**: 15 questions
- **For Mnemo**: 7 questions (Q-009 to Q-015)
- **For DE**: 8 questions (Q-001 to Q-008)
- **Average Age**: < 1 day

---

## ✅ Next Actions for Mnemo Team

1. **Review the Q&A system docs**: [CROSS-TEAM-QA-SYSTEM.md](/home/chris/nexus/docs/CROSS-TEAM-QA-SYSTEM.md)
2. **Answer the 7 questions**: On [CROSS-TEAM-QA-BOARD.md](/home/chris/nexus/docs/CROSS-TEAM-QA-BOARD.md)
3. **Add to startup routine**: Check Q&A board daily
4. **Add to wrap-up routine**: Ask new questions before ending session
5. **Update CLAUDE.md**: Add Q&A reminders to Mnemo project instructions

---

## 🤔 Questions About This System?

Use the Q&A system to ask about the Q&A system! 😄

```markdown
### [Q-NEW] Question About Q&A Process
**From**: Mnemo → **To**: Chris
**Category**: Process
**Priority**: 🟢 Medium

**Question**: [Your question about how to use the Q&A system]
```

---

## 📚 Related Documents

- **Q&A System Documentation**: [CROSS-TEAM-QA-SYSTEM.md](/home/chris/nexus/docs/CROSS-TEAM-QA-SYSTEM.md)
- **Q&A Board**: [CROSS-TEAM-QA-BOARD.md](/home/chris/nexus/docs/CROSS-TEAM-QA-BOARD.md)
- **Nexus-Mnemo Integration**: [TEAM-LEADER-SUMMARY.md](/home/chris/nexus/docs/TEAM-LEADER-SUMMARY.md)

---

**Thank you for adopting this system!** It will help us scale collaboration as the ecosystem grows.

**Questions?** Add them to the Q&A board → From: Mnemo, To: Chris 🚀
