import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { api } from '../api/client';
import type { ParalegalName } from 'shared/types';

interface AuthState {
  token: string | null;
  paralegal: ParalegalName | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  selectParalegal: (name: ParalegalName) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

const TOKEN_KEY = 'doc-triage-token';
const PARALEGAL_KEY = 'doc-triage-paralegal';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [paralegal, setParalegal] = useState<ParalegalName | null>(
    () => (localStorage.getItem(PARALEGAL_KEY) as ParalegalName) || null,
  );
  const [loading, setLoading] = useState(false);

  // Keep api client in sync with token
  useEffect(() => {
    api.setToken(token);
  }, [token]);

  // Listen for session expiry events
  useEffect(() => {
    const handler = () => {
      setToken(null);
      setParalegal(null);
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(PARALEGAL_KEY);
    };
    window.addEventListener('auth:expired', handler);
    return () => window.removeEventListener('auth:expired', handler);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setLoading(true);
    try {
      const res = await api.post<{ token: string }>('/auth/login', { email, password });
      setToken(res.token);
      localStorage.setItem(TOKEN_KEY, res.token);
    } finally {
      setLoading(false);
    }
  }, []);

  const selectParalegal = useCallback(
    async (name: ParalegalName) => {
      setLoading(true);
      try {
        const res = await api.post<{ token: string; paralegal: string }>('/auth/select-paralegal', {
          name,
        });
        setToken(res.token);
        setParalegal(name);
        localStorage.setItem(TOKEN_KEY, res.token);
        localStorage.setItem(PARALEGAL_KEY, name);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const logout = useCallback(() => {
    setToken(null);
    setParalegal(null);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(PARALEGAL_KEY);
    api.setToken(null);
  }, []);

  return (
    <AuthContext.Provider value={{ token, paralegal, loading, login, selectParalegal, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
