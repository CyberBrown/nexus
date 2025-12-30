# Deploy Instructions for FTS5 Multi-Word Search Fix

## Problem
GitHub Actions deployments have been failing, preventing the FTS5 multi-word search fix from being deployed.

## Required Steps

### 1. Fix GitHub Secrets
Go to: https://github.com/CyberBrown/Nexus/settings/secrets/actions

Add or update the following secret:
- **Name:** `CLOUDFLARE_API_TOKEN`
- **Value:** Your Cloudflare API Token with Workers/D1 permissions

To create a new Cloudflare API Token:
1. Go to: https://dash.cloudflare.com/profile/api-tokens
2. Click "Create Token"
3. Use the "Edit Cloudflare Workers" template
4. Add D1 Database permissions
5. Copy the token and add it to GitHub Secrets

### 2. Re-run Deployment
After updating the secret:
1. Go to: https://github.com/CyberBrown/Nexus/actions
2. Click on the latest failed workflow run
3. Click "Re-run all jobs" or push a new commit to trigger deployment

### 3. Verify Deployment
After deployment succeeds:
```bash
# Test the search API
curl -X POST "https://nexus-mcp.solamp.workers.dev/rebuild-fts" \
  -H "X-Passphrase: stale-coffee-44"

# The FTS index should rebuild with the new code
```

### Alternative: Manual Deployment
If you have the Cloudflare API Token locally:
```bash
cd ~/projects/nexus
export CLOUDFLARE_API_TOKEN="your-token-here"
./scripts/apply-fts-fix.sh
```

## What Was Fixed
- FTS5 multi-word search now uses OR + post-filter pattern
- This works around D1's unreliable AND operator behavior
- Fall back to LIKE search and full scan for comprehensive coverage
