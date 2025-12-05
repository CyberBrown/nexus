/**
 * Authentication context for Qwik
 * Provides auth state and methods throughout the app
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
  tenant_id: string;
}

export interface AuthState {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}

export interface AuthContextValue {
  state: AuthState;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  setToken: (token: string) => void;
}

// Create context
export const AuthContext = createContextId<AuthContextValue>('auth-context');

// Auth provider component
export const AuthProvider = component$(() => {
  const user = useSignal<AuthUser | null>(null);
  const isAuthenticated = useSignal(false);
  const isLoading = useSignal(true);

  // Check for existing token on mount
  useVisibleTask$(({ track }) => {
    track(() => isLoading.value);

    if (typeof window !== 'undefined') {
      const token = localStorage.getItem('nexus_token');
      if (token) {
        apiClient.setToken(token);
        // In a real app, validate token with API
        // For dev, just mark as authenticated
        isAuthenticated.value = true;

        // Try to get user info
        const userJson = localStorage.getItem('nexus_user');
        if (userJson) {
          try {
            user.value = JSON.parse(userJson);
          } catch (e) {
            console.error('Failed to parse user data', e);
          }
        }
      }
      isLoading.value = false;
    }
  });

  const login = $(async (email: string, password: string) => {
    // TODO: Implement proper login API call
    // For now, this is a placeholder for dev JWT auth
    console.log('Login not fully implemented - using dev mode');

    // In dev mode, accept any login and use dev token
    const devToken = 'dev-token-placeholder';
    const devUser: AuthUser = {
      id: 'user_dev',
      email: email,
      name: 'Dev User',
      tenant_id: 'tenant_dev',
    };

    apiClient.setToken(devToken);
    user.value = devUser;
    isAuthenticated.value = true;

    if (typeof window !== 'undefined') {
      localStorage.setItem('nexus_user', JSON.stringify(devUser));
    }
  });

  const logout = $(() => {
    apiClient.clearToken();
    user.value = null;
    isAuthenticated.value = false;

    if (typeof window !== 'undefined') {
      localStorage.removeItem('nexus_user');
    }
  });

  const setToken = $((token: string) => {
    apiClient.setToken(token);
    isAuthenticated.value = true;
  });

  const contextValue: AuthContextValue = {
    state: {
      user: user.value,
      isAuthenticated: isAuthenticated.value,
      isLoading: isLoading.value,
    },
    login,
    logout,
    setToken,
  };

  useContextProvider(AuthContext, contextValue);

  return <Slot />;
});

// Hook to use auth context
export const useAuth = () => {
  return useContext(AuthContext);
};
