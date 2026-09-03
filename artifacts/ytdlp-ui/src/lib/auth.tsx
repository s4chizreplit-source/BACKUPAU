/**
 * Account state for the whole app — session-cookie auth against /api/auth/*.
 * Wrap the tree in <AuthProvider>; read with useAuth().
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export const API = import.meta.env.VITE_API_URL
  ? import.meta.env.VITE_API_URL.replace(/\/$/, '')
  : import.meta.env.BASE_URL.replace(/\/$/, '') + '/api';

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  role: 'user' | 'admin';
  status: 'active' | 'disabled';
  plan: 'none' | '30' | '100' | '250';
  planInterval: 'monthly' | 'yearly' | null;
  planStatus: 'none' | 'active' | 'cancelled' | 'expired';
  paidUntil: string | null;
  /** Cutting and upload processing are metered independently. */
  credits: {
    cutting: CreditBalance;
    uploading: CreditBalance;
  };
  createdAt: string;
}

export interface CreditBalance {
  subscription: number;
  topup: number;
  legacy: number;
  total: number;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** JSON fetch against the API with session cookies + friendly errors. */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(data?.error || `Error ${res.status}`, res.status, data?.code);
  }
  return data as T;
}

interface AuthCtxValue {
  user: AuthUser | null;
  /** True until the first /auth/me round-trip finishes. */
  loading: boolean;
  refresh: () => Promise<void>;
  login: (email: string, password: string) => Promise<AuthUser>;
  signup: (email: string, password: string, name?: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
}

const AuthCtx = createContext<AuthCtxValue>({
  user: null,
  loading: true,
  refresh: async () => {},
  login: async () => { throw new Error('AuthProvider missing'); },
  signup: async () => { throw new Error('AuthProvider missing'); },
  logout: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const d = await apiFetch<{ user: AuthUser | null }>('/auth/me');
      setUser(d.user);
    } catch {
      /* network blip — keep the current state */
    }
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const d = await apiFetch<{ user: AuthUser }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    setUser(d.user);
    return d.user;
  }, []);

  const signup = useCallback(async (email: string, password: string, name?: string) => {
    // If the visitor arrived through a referral link (?ref=… stored for 30
    // days), attach the code so the referrer gets credited on plan purchase.
    let ref: string | undefined;
    try {
      const raw = localStorage.getItem('autocliper_ref');
      if (raw) {
        const r = JSON.parse(raw);
        if (typeof r?.code === 'string' && Date.now() - (r.ts ?? 0) < 30 * 24 * 3600 * 1000) {
          ref = r.code;
        }
      }
    } catch { /* ignore */ }
    const d = await apiFetch<{ user: AuthUser }>('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ email, password, name, ...(ref ? { ref } : {}) }),
    });
    try { localStorage.removeItem('autocliper_ref'); } catch { /* ignore */ }
    setUser(d.user);
    return d.user;
  }, []);

  const logout = useCallback(async () => {
    try { await apiFetch('/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    setUser(null);
  }, []);

  return (
    <AuthCtx.Provider value={{ user, loading, refresh, login, signup, logout }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth(): AuthCtxValue {
  return useContext(AuthCtx);
}
