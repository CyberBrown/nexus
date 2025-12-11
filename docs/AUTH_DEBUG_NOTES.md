# Cloudflare Access Auth - Debugging Notes

## Current Status: Not Working

Access login flow works, but the Worker isn't receiving/validating the JWT.

## What's Been Done

### Backend Implementation (Complete)
- `src/lib/auth.ts` - Rewrote to validate Cloudflare Access JWTs via `jose` library
- Added `/api/auth/me` endpoint to return user info
- Auto-provisioning of users/tenants on first login
- Falls back to dev tokens in development mode

### Secrets Configured
```
TEAM_DOMAIN = https://solamp.cloudflareaccess.com
POLICY_AUD = 82aae4fcb40dd5f98eddf097cb5a0f88a90440d14af0ef7c38f5e1c3d45fd95f
```

### Access Application Settings
- **Application URL**: nexus.solamp.workers.dev
- **Policy**: "password auth" with email OTP
- **Allowed email**: brown.cy@gmail.com

## The Problem

After logging in via Cloudflare Access:
1. User enters email, receives OTP code
2. User enters code, Access authenticates successfully
3. User is redirected to `/api/auth/me`
4. Worker returns: `{"success":false,"error":"Missing authorization. Use Cloudflare Access or dev token."}`

This means the `Cf-Access-Jwt-Assertion` header is NOT being received by the Worker.

## Possible Causes to Investigate

### 1. Access not adding JWT header
- Access might not be configured to inject the JWT for this application
- Check if there's a setting to enable JWT injection

### 2. workers.dev domain issue
- Cloudflare Access may behave differently with `*.workers.dev` subdomains
- Might need a custom domain for Access to work properly
- Try: Add a custom domain to the Worker and protect that instead

### 3. Path configuration
- The Access application might only be protecting `/` not `/api/*`
- Try adding explicit path `/api/*` in Access application settings

### 4. Cookie vs Header
- Access sends JWT as both `CF_Authorization` cookie AND `Cf-Access-Jwt-Assertion` header
- Worker is looking for header - maybe check cookie too?

## Debug Steps for Next Session

### 1. Check if JWT header is present
Add logging to `src/lib/auth.ts`:
```typescript
// At start of authMiddleware
console.log('Headers:', JSON.stringify(Object.fromEntries(c.req.raw.headers)));
console.log('Cf-Access-Jwt-Assertion:', c.req.header('Cf-Access-Jwt-Assertion'));
console.log('Cookie:', c.req.header('Cookie'));
```

Deploy and check logs with `npx wrangler tail`

### 2. Try reading from cookie instead
The JWT might be in `CF_Authorization` cookie instead of header:
```typescript
const cookieHeader = c.req.header('Cookie');
const cfAuthCookie = cookieHeader?.match(/CF_Authorization=([^;]+)/)?.[1];
```

### 3. Try custom domain
- Add custom domain to Worker in Cloudflare dashboard
- Update Access application to use custom domain
- This is the most likely fix

### 4. Check Access application type
- Make sure it's "Self-hosted" not "SaaS" or other type
- Verify the domain configuration matches exactly

## Files Changed in This Session

- `src/lib/auth.ts` - Cloudflare Access JWT validation
- `src/types/index.ts` - Added TEAM_DOMAIN, POLICY_AUD, userEmail
- `src/index.ts` - Added `/api/auth/me` endpoint
- `wrangler.toml` - Added placeholder comments for Access vars
- `package.json` - Added `jose` dependency
- `web/src/lib/auth-context.tsx` - Updated for Access auth
- `web/src/lib/api-client.ts` - Added `getMe()` method
- `CLAUDE.md` - Updated documentation

## Quick Test Commands

```bash
# Check if Access header is being sent (run after logging in)
curl -v https://nexus.solamp.workers.dev/api/auth/me \
  -H "Cookie: <copy CF_Authorization cookie from browser>"

# View Worker logs
npx wrangler tail --format=pretty

# Redeploy
npm run deploy
```

## References

- [Cloudflare Access JWT Validation](https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/)
- [Access with Workers](https://developers.cloudflare.com/cloudflare-one/tutorials/access-workers/)
