import type { Context, Next } from 'hono';
import type { AppType } from '../types/index.ts';

// Simple JWT-like auth for now
// In production, use proper JWT validation with jose or similar

interface TokenPayload {
  tenant_id: string;
  user_id: string;
  exp: number;
}

// Decode a simple base64-encoded JSON token (NOT secure - for dev only)
// Replace with proper JWT validation in production
function decodeToken(token: string): TokenPayload | null {
  try {
    const payload = JSON.parse(atob(token));
    if (payload.tenant_id && payload.user_id && payload.exp) {
      return payload as TokenPayload;
    }
    return null;
  } catch {
    return null;
  }
}

// Auth middleware
export function authMiddleware() {
  return async (c: Context<AppType>, next: Next) => {
    const authHeader = c.req.header('Authorization');

    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ success: false, error: 'Missing or invalid authorization header' }, 401);
    }

    const token = authHeader.slice(7);
    const payload = decodeToken(token);

    if (!payload) {
      return c.json({ success: false, error: 'Invalid token' }, 401);
    }

    if (payload.exp < Date.now()) {
      return c.json({ success: false, error: 'Token expired' }, 401);
    }

    // Verify tenant exists
    const tenant = await c.env.DB.prepare(
      'SELECT id FROM tenants WHERE id = ? AND deleted_at IS NULL'
    ).bind(payload.tenant_id).first();

    if (!tenant) {
      return c.json({ success: false, error: 'Invalid tenant' }, 401);
    }

    // Attach auth info to context
    c.set('tenantId', payload.tenant_id);
    c.set('userId', payload.user_id);

    await next();
  };
}

// Helper to get auth info from context
export function getAuth(c: Context<AppType>): { tenantId: string; userId: string } {
  return {
    tenantId: c.get('tenantId'),
    userId: c.get('userId'),
  };
}

// Generate a dev token (for testing only)
export function generateDevToken(tenantId: string, userId: string, expiresInMs = 86400000): string {
  const payload: TokenPayload = {
    tenant_id: tenantId,
    user_id: userId,
    exp: Date.now() + expiresInMs,
  };
  return btoa(JSON.stringify(payload));
}
