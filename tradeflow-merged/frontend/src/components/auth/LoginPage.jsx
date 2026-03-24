import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

export default function LoginPage() {
  const { login, loginWithUpstox } = useAuth();
  const navigate  = useNavigate();
  const location  = useLocation();
  const from      = location.state?.from?.pathname || '/dashboard';

  const [form,    setForm]    = useState({ email: '', password: '' });
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      await login(form.email, form.password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        {/* Logo */}
        <div style={styles.logoRow}>
          <div style={styles.logo}>TF</div>
          <div>
            <div style={styles.appName}>TradeFlow</div>
            <div style={styles.appTag}>NSE · BSE · F&O</div>
          </div>
        </div>

        <h2 style={styles.heading}>Sign in to your account</h2>

        {/* Upstox OAuth button */}
        <button onClick={loginWithUpstox} style={styles.upstoxBtn} type="button">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ marginRight: 8 }}>
            <circle cx="12" cy="12" r="10" fill="#7B3FE4"/>
            <path d="M8 12l3 3 5-6" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Continue with Upstox
        </button>

        <div style={styles.divider}>
          <span style={styles.dividerLine}/>
          <span style={styles.dividerText}>or sign in with email</span>
          <span style={styles.dividerLine}/>
        </div>

        {/* Email/Password form */}
        <form onSubmit={handleSubmit} style={styles.form}>
          {error && <div style={styles.errorBox}>{error}</div>}

          <label style={styles.label}>
            Email address
            <input
              type="email"
              value={form.email}
              onChange={e => setForm(p => ({ ...p, email: e.target.value }))}
              style={styles.input}
              placeholder="you@example.com"
              required
              autoComplete="email"
            />
          </label>

          <label style={styles.label}>
            Password
            <input
              type="password"
              value={form.password}
              onChange={e => setForm(p => ({ ...p, password: e.target.value }))}
              style={styles.input}
              placeholder="••••••••"
              required
              autoComplete="current-password"
            />
          </label>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
            <a href="/auth/forgot-password" style={styles.link}>Forgot password?</a>
          </div>

          <button type="submit" disabled={loading} style={{
            ...styles.submitBtn,
            opacity: loading ? 0.7 : 1,
            cursor: loading ? 'not-allowed' : 'pointer',
          }}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p style={styles.registerText}>
          Don't have an account?{' '}
          <a href="/auth/register" style={styles.link}>Create one</a>
        </p>
      </div>
    </div>
  );
}

// ─── Upstox OAuth callback handler ────────────────────────────────────────
// Place this at /auth/callback route — AuthContext reads the hash automatically
export function UpstoxCallbackPage() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
      <p style={{ color: 'var(--color-text-secondary)', fontSize: 14 }}>Completing sign-in…</p>
    </div>
  );
}

// ─── Error page ────────────────────────────────────────────────────────────
export function AuthErrorPage() {
  const reason = new URLSearchParams(window.location.search).get('reason') || 'unknown';
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', flexDirection: 'column', gap: 12 }}>
      <p style={{ color: '#A32D2D', fontSize: 16 }}>Authentication failed: {reason}</p>
      <a href="/auth/login" style={{ color: '#185FA5', fontSize: 14 }}>Try again</a>
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--color-background-tertiary)',
    padding: 16,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    background: 'var(--color-background-primary)',
    borderRadius: 12,
    border: '0.5px solid var(--color-border-tertiary)',
    padding: '32px 36px',
  },
  logoRow: {
    display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24,
  },
  logo: {
    width: 40, height: 40, borderRadius: 10,
    background: '#0C447C', color: '#fff',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontWeight: 600, fontSize: 14,
  },
  appName:  { fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)' },
  appTag:   { fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 1 },
  heading: {
    fontSize: 18, fontWeight: 500, color: 'var(--color-text-primary)',
    margin: '0 0 20px',
  },
  upstoxBtn: {
    width: '100%', padding: '11px 16px',
    background: 'var(--color-background-secondary)',
    border: '0.5px solid var(--color-border-secondary)',
    borderRadius: 8, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 14, fontWeight: 500, color: 'var(--color-text-primary)',
    marginBottom: 20,
  },
  divider: {
    display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20,
  },
  dividerLine: {
    flex: 1, height: 1, background: 'var(--color-border-tertiary)',
  },
  dividerText: {
    fontSize: 12, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap',
  },
  form:  { display: 'flex', flexDirection: 'column', gap: 14 },
  label: {
    display: 'flex', flexDirection: 'column', gap: 6,
    fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)',
  },
  input: {
    padding: '10px 12px', borderRadius: 6,
    border: '0.5px solid var(--color-border-secondary)',
    background: 'var(--color-background-primary)',
    color: 'var(--color-text-primary)', fontSize: 14, outline: 'none',
  },
  errorBox: {
    background: 'var(--color-background-danger)',
    color: 'var(--color-text-danger)',
    border: '0.5px solid var(--color-border-danger)',
    borderRadius: 6, padding: '10px 12px', fontSize: 13,
  },
  submitBtn: {
    padding: '11px 16px', borderRadius: 8,
    background: '#185FA5', color: '#fff',
    border: 'none', fontSize: 14, fontWeight: 500, cursor: 'pointer',
    marginTop: 4,
  },
  registerText: { textAlign: 'center', fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 20 },
  link: { color: '#185FA5', textDecoration: 'none', fontWeight: 500 },
};
