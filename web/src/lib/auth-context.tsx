/**
 * Authentication context for Qwik
 * Supports Cloudflare Access (production) and dev tokens (development)
 */

import {
  component$,
  createContextId,
  Slot,
  useContextProvider,
  useSignal,
  useContext,
  useVisibleTask$,
  $,
} from '@builder.io/qwik';
import { apiClient } from './api-client';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
  timezone: string;
}

export interface AuthTenant {
  id: string;
  name: string;
}

export interface AuthState {
  user: AuthUser | null;
  tenant: AuthTenant | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  authMethod: 'access' | 'dev' | null;
}

export interface AuthContextValue {
  state: AuthState;
  login: (email: string, password: string) => Promise<boolean>;
  logout: () => void;
  setDevToken: (token: string) => void;
  checkAuth: () => Promise<boolean>;
}

// Create context
export const AuthContext = createContextId<AuthContextValue>('auth-context');

// Auth provider component
export const AuthProvider = component$(() => {
  const user = useSignal<AuthUser | null>(null);
  const tenant = useSignal<AuthTenant | null>(null);
  const isAuthenticated = useSignal(false);
  const isLoading = useSignal(true);
  const authMethod = useSignal<'access' | 'dev' | null>(null);

  // Check authentication status on mount
  useVisibleTask$(async () => {
    try {
      // Try to fetch /auth/me - works with both Access and dev tokens
      const response = await apiClient.getMe();

      if (response.user) {
        user.value = response.user;
        tenant.value = response.tenant;
        isAuthenticated.value = true;
        // Determine auth method based on whether we have a dev token stored
        authMethod.value = localStorage.getItem('nexus_token') ? 'dev' : 'access';
      }
    } catch (error) {
      // Not authenticated or API not available
      console.log('Auth check failed:', error);
      isAuthenticated.value = false;
      user.value = null;
      tenant.value = null;
    } finally {
      isLoading.value = false;
    }
  });

  // Dev login (for development environment only)
  const login = $(async (email: string, _password: string): Promise<boolean> => {
    try {
      // Call the /setup endpoint to create a dev user and get a token
      const response = await fetch('/setup', { method: 'POST' });

      if (!response.ok) {
        console.error('Dev setup failed - may not be in development mode');
        return false;
      }

      const data = await response.json();

      if (data.success && data.data?.token) {
        apiClient.setToken(data.data.token);
        authMethod.value = 'dev';

        // Now fetch user info
        const meResponse = await apiClient.getMe();
        user.value = meResponse.user;
        tenant.value = meResponse.tenant;
        isAuthenticated.value = true;

        return true;
      }

      return false;
    } catch (error) {
      console.error('Login error:', error);
      return false;
    }
  });

  const logout = $(() => {
    apiClient.clearToken();
    user.value = null;
    tenant.value = null;
    isAuthenticated.value = false;
    authMethod.value = null;

    // If using Cloudflare Access, redirect to logout URL
    // Access logout: https://<team-domain>/cdn-cgi/access/logout
    // For now, just clear local state - Access handles session via cookies
  });

  const setDevToken = $((token: string) => {
    apiClient.setToken(token);
    authMethod.value = 'dev';
  });

  const checkAuth = $(async (): Promise<boolean> => {
    try {
      const response = await apiClient.getMe();
      if (response.user) {
        user.value = response.user;
        tenant.value = response.tenant;
        isAuthenticated.value = true;
        return true;
      }
      return false;
    } catch {
      isAuthenticated.value = false;
      return false;
    }
  });

  const contextValue: AuthContextValue = {
    state: {
      user: user.value,
      tenant: tenant.value,
      isAuthenticated: isAuthenticated.value,
      isLoading: isLoading.value,
      authMethod: authMethod.value,
    },
    login,
    logout,
    setDevToken,
    checkAuth,
  };

  useContextProvider(AuthContext, contextValue);

  return <Slot />;
});

// Hook to use auth context
export const useAuth = () => {
  return useContext(AuthContext);
};
