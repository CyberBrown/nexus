import type { Context, Next } from 'hono';
import { jwtVerify, createRemoteJWKSet, type JWTPayload } from 'jose';
import type { AppType, Env } from '../types/index.ts';
import { generateTenantKey } from './encryption.ts';

// Cloudflare Access JWT payload (user auth)
interface AccessJWTPayload extends JWTPayload {
  email?: string; // Not present for service tokens
  sub: string; // User ID from Access (empty for service tokens)
  aud: string | string[];
  iss: string;
  iat: number;
  exp: number;
  type?: string; // 'app' for service tokens
  identity_nonce?: string;
  name?: string;
  country?: string;
  common_name?: string; // Service token client ID
}

// Cache JWKS to avoid fetching on every request
let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksCacheTeamDomain: string | null = null;

function getJWKS(teamDomain: string) {
  // Return cached JWKS if same team domain
  if (jwksCache && jwksCacheTeamDomain === teamDomain) {
    return jwksCache;
  }

  // Create new JWKS and cache it
  jwksCache = createRemoteJWKSet(
    new URL(`${teamDomain}/cdn-cgi/access/certs`)
  );
  jwksCacheTeamDomain = teamDomain;
  return jwksCache;
}

// Validate Cloudflare Access JWT
async function validateAccessToken(
  token: string,
  env: Env
): Promise<AccessJWTPayload | null> {
  const teamDomain = env.TEAM_DOMAIN;
  const policyAud = env.POLICY_AUD;

  if (!teamDomain || !policyAud) {
    console.error('Missing TEAM_DOMAIN or POLICY_AUD environment variables');
    return null;
  }

  try {
    const JWKS = getJWKS(teamDomain);

    const { payload } = await jwtVerify(token, JWKS, {
      issuer: teamDomain,
      audience: policyAud,
    });

    return payload as AccessJWTPayload;
  } catch (error) {
    console.error('Access JWT validation failed:', error);
    return null;
  }
}

// Legacy dev token (for development only)
interface DevTokenPayload {
  tenant_id: string;
  user_id: string;
  exp: number;
}

function decodeDevToken(token: string): DevTokenPayload | null {
  try {
    const payload = JSON.parse(atob(token));
    if (payload.tenant_id && payload.user_id && payload.exp) {
      return payload as DevTokenPayload;
    }
    return null;
  } catch {
    return null;
  }
}

// Find service token by common_name (client ID in JWT)
async function findServiceTokenByCommonName(
  db: D1Database,
  commonName: string
): Promise<{ tenantId: string; userId: string; serviceName: string } | null> {
  // common_name in the JWT contains the service token client ID
  const token = await db.prepare(`
    SELECT st.tenant_id, st.user_id, st.name
    FROM service_tokens st
    WHERE st.client_id = ? AND st.revoked_at IS NULL AND st.deleted_at IS NULL
  `).bind(commonName).first<{
    tenant_id: string;
    user_id: string;
    name: string;
  }>();

  if (!token) {
    return null;
  }

  return {
    tenantId: token.tenant_id,
    userId: token.user_id,
    serviceName: token.name,
  };
}

// Find or create user from Access JWT
async function findOrCreateUser(
  db: D1Database,
  kv: KVNamespace,
  payload: AccessJWTPayload
): Promise<{ tenantId: string; userId: string; isNewUser: boolean } | null> {
  const email = payload.email;

  if (!email) {
    console.error('No email in Access JWT payload');
    return null;
  }

  // Try to find existing user by email
  const existingUser = await db.prepare(`
    SELECT u.id as user_id, u.tenant_id
    FROM users u
    WHERE u.email = ? AND u.deleted_at IS NULL
  `).bind(email).first<{ user_id: string; tenant_id: string }>();

  if (existingUser) {
    return {
      tenantId: existingUser.tenant_id,
      userId: existingUser.user_id,
      isNewUser: false,
    };
  }

  // User doesn't exist - auto-provision on first login
  const now = new Date().toISOString();
  const tenantId = crypto.randomUUID();
  const userId = crypto.randomUUID();

  // Create tenant
  await db.prepare(`
    INSERT INTO tenants (id, name, encryption_key_ref, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(tenantId, `${email}'s Workspace`, `tenant:${tenantId}:key`, now, now).run();

  // Generate encryption key for tenant
  await generateTenantKey(kv, tenantId);

  // Create user
  const name = payload.name || email.split('@')[0];
  await db.prepare(`
    INSERT INTO users (id, tenant_id, email, name, role, timezone, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(userId, tenantId, email, name, 'owner', 'UTC', now, now).run();

  console.log(`Auto-provisioned new user: ${email} (tenant: ${tenantId}, user: ${userId})`);

  return { tenantId, userId, isNewUser: true };
}

// Auth middleware - supports Cloudflare Access (user + service token) and dev tokens
export function authMiddleware() {
  return async (c: Context<AppType>, next: Next) => {
    const env = c.env;

    // Check for Cloudflare Access JWT (handles both user auth and service tokens)
    const accessToken = c.req.header('Cf-Access-Jwt-Assertion');

    console.log('Auth check:', {
      hasAccessToken: !!accessToken,
      hasTeamDomain: !!env.TEAM_DOMAIN,
      hasPolicyAud: !!env.POLICY_AUD,
    });

    if (accessToken && env.TEAM_DOMAIN && env.POLICY_AUD) {
      const payload = await validateAccessToken(accessToken, env);

      if (!payload) {
        return c.json({ success: false, error: 'Invalid Access token' }, 401);
      }

      // Check if this is a service token (type === 'app')
      if (payload.type === 'app' && payload.common_name) {
        // Service token auth - look up by common_name (client ID)
        const serviceAuth = await findServiceTokenByCommonName(env.DB, payload.common_name);

        if (!serviceAuth) {
          return c.json({
            success: false,
            error: 'Service token not registered. Register the service token in the database.'
          }, 401);
        }

        c.set('tenantId', serviceAuth.tenantId);
        c.set('userId', serviceAuth.userId);
        c.set('userEmail', `service:${serviceAuth.serviceName}`);

        await next();
        return;
      }

      // Regular user auth - find or create user by email
      const user = await findOrCreateUser(env.DB, env.KV, payload);

      if (!user) {
        return c.json({ success: false, error: 'User provisioning failed' }, 500);
      }

      c.set('tenantId', user.tenantId);
      c.set('userId', user.userId);
      c.set('userEmail', payload.email);

      await next();
      return;
    }

    // Fall back to dev token (development only)
    if (env.ENVIRONMENT === 'development') {
      const authHeader = c.req.header('Authorization');

      if (!authHeader?.startsWith('Bearer ')) {
        return c.json({
          success: false,
          error: 'Missing authorization. Use Cloudflare Access or dev token.'
        }, 401);
      }

      const token = authHeader.slice(7);
      const payload = decodeDevToken(token);

      if (!payload) {
        return c.json({ success: false, error: 'Invalid dev token' }, 401);
      }

      if (payload.exp < Date.now()) {
        return c.json({ success: false, error: 'Dev token expired' }, 401);
      }

      // Verify tenant exists
      const tenant = await env.DB.prepare(
        'SELECT id FROM tenants WHERE id = ? AND deleted_at IS NULL'
      ).bind(payload.tenant_id).first();

      if (!tenant) {
        return c.json({ success: false, error: 'Invalid tenant' }, 401);
      }

      c.set('tenantId', payload.tenant_id);
      c.set('userId', payload.user_id);

      await next();
      return;
    }

    // No valid auth found
    return c.json({
      success: false,
      error: 'Authentication required. Enable Cloudflare Access for this application.'
    }, 401);
  };
}

// Helper to get auth info from context
export function getAuth(c: Context<AppType>): { tenantId: string; userId: string; userEmail?: string } {
  return {
    tenantId: c.get('tenantId'),
    userId: c.get('userId'),
    userEmail: c.get('userEmail'),
  };
}

// Generate a dev token (for testing only - development environment)
export function generateDevToken(tenantId: string, userId: string, expiresInMs = 86400000): string {
  const payload: DevTokenPayload = {
    tenant_id: tenantId,
    user_id: userId,
    exp: Date.now() + expiresInMs,
  };
  return btoa(JSON.stringify(payload));
}
