import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3000';

const AuthContext = createContext(null);

/**
 * AuthProvider — wraps the app and provides:
 *   - user, accessToken, isAuthenticated
 *   - login(), logout(), loginWithUpstox()
 *   - authFetch() — auto-attaches JWT + Upstox token + handles 401 refresh
 */
export function AuthProvider({ children }) {
  const [user, setUser]               = useState(null);
  const [accessToken, setAccessToken] = useState(null);
  const [upstoxToken, setUpstoxToken] = useState(null);
  const [loading, setLoading]         = useState(true);
  const refreshTimerRef               = useRef(null);

  // ─── Persist refresh token in httpOnly-equivalent (localStorage for demo) ─
  // In production: use httpOnly cookie set by the server
  const persistRefresh = (token) => localStorage.setItem('tf_refresh', token);
  const getPersistedRefresh = () => localStorage.getItem('tf_refresh');
  const clearPersisted = () => localStorage.removeItem('tf_refresh');

  // ─── Schedule silent access-token refresh before it expires (15m - 1m) ──
  function scheduleRefresh(token) {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    // JWT payload contains exp in seconds
    try {
      const { exp } = JSON.parse(atob(token.split('.')[1]));
      const msUntilExpiry = exp * 1000 - Date.now();
      const refreshIn = Math.max(msUntilExpiry - 60_000, 5000); // 1 min before expiry
      refreshTimerRef.current = setTimeout(silentRefresh, refreshIn);
    } catch {}
  }

  async function silentRefresh() {
    const refreshToken = getPersistedRefresh();
    if (!refreshToken) { logout(); return; }
    try {
      const res  = await fetch(`${API}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) throw new Error('Refresh failed');
      const data = await res.json();
      setAccessToken(data.accessToken);
      persistRefresh(data.refreshToken);
      scheduleRefresh(data.accessToken);
    } catch {
      logout();
    }
  }

  // ─── Boot: try to restore session from persisted refresh token ───────────
  useEffect(() => {
    (async () => {
      const refreshToken = getPersistedRefresh();
      if (!refreshToken) { setLoading(false); return; }
      try {
        const res = await fetch(`${API}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) throw new Error();
        const data = await res.json();
        setAccessToken(data.accessToken);
        persistRefresh(data.refreshToken);
        scheduleRefresh(data.accessToken);
        // Fetch user profile
        const me = await fetch(`${API}/api/auth/me`, {
          headers: { Authorization: `Bearer ${data.accessToken}` },
        });
        if (me.ok) setUser(await me.json());
      } catch {
        clearPersisted();
      } finally {
        setLoading(false);
      }
    })();
    return () => clearTimeout(refreshTimerRef.current);
  }, []);

  // ─── Handle Upstox OAuth callback (#access_token=...&refresh_token=...) ──
  useEffect(() => {
    if (!window.location.hash.includes('access_token')) return;
    const params = new URLSearchParams(window.location.hash.slice(1));
    const at = params.get('access_token');
    const rt = params.get('refresh_token');
    if (at && rt) {
      setAccessToken(at);
      persistRefresh(rt);
      scheduleRefresh(at);
      // Clean URL
      window.history.replaceState(null, '', window.location.pathname);
      // Fetch user
      fetch(`${API}/api/auth/me`, { headers: { Authorization: `Bearer ${at}` } })
        .then(r => r.json()).then(setUser).catch(() => {});
      setLoading(false);
    }
  }, []);

  // ─── email/password login ─────────────────────────────────────────────────
  const login = useCallback(async (email, password) => {
    const res = await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    setAccessToken(data.accessToken);
    setUser(data.user);
    persistRefresh(data.refreshToken);
    scheduleRefresh(data.accessToken);
    return data.user;
  }, []);

  // ─── Upstox OAuth2 login ──────────────────────────────────────────────────
  const loginWithUpstox = useCallback(() => {
    window.location.href = `${API}/api/auth/upstox/login`;
  }, []);

  // ─── Get fresh Upstox access token (for order/market API calls) ───────────
  const getUpstoxToken = useCallback(async () => {
    if (!accessToken) return null;
    if (upstoxToken) return upstoxToken;
    try {
      const res = await fetch(`${API}/api/auth/upstox/token`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return null;
      const { access_token } = await res.json();
      setUpstoxToken(access_token);
      // Upstox tokens last ~24h; clear our cache after 23h
      setTimeout(() => setUpstoxToken(null), 23 * 60 * 60 * 1000);
      return access_token;
    } catch {
      return null;
    }
  }, [accessToken, upstoxToken]);

  // ─── logout ───────────────────────────────────────────────────────────────
  const logout = useCallback(async () => {
    const rt = getPersistedRefresh();
    try {
      if (accessToken) {
        await fetch(`${API}/api/auth/logout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: rt }),
        });
      }
    } catch {}
    clearPersisted();
    clearTimeout(refreshTimerRef.current);
    setAccessToken(null);
    setUser(null);
    setUpstoxToken(null);
  }, [accessToken]);

  /**
   * authFetch — drop-in replacement for fetch() that:
   *   1. Attaches Authorization: Bearer <accessToken>
   *   2. Attaches X-Upstox-Token if available
   *   3. On 401, tries a silent token refresh then retries once
   */
  const authFetch = useCallback(async (url, options = {}) => {
    const upstox = await getUpstoxToken();
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(upstox ? { 'X-Upstox-Token': upstox } : {}),
    };

    let res = await fetch(`${API}${url}`, { ...options, headers });

    // Auto-retry on 401 after a silent refresh
    if (res.status === 401) {
      await silentRefresh();
      headers.Authorization = `Bearer ${accessToken}`;
      res = await fetch(`${API}${url}`, { ...options, headers });
    }

    return res;
  }, [accessToken, getUpstoxToken]);

  return (
    <AuthContext.Provider value={{
      user, accessToken, upstoxToken,
      isAuthenticated: !!accessToken,
      loading,
      login, logout, loginWithUpstox,
      getUpstoxToken, authFetch,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
};
