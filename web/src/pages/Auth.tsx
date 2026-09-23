import { useState, type FormEvent } from 'react';
import { Link as RouterLink, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, type RateLimitInfo } from '../api/client';
import { Icon } from '../components/Icon';
import { RateLimitBanner } from '../components/RateLimitBanner';
import { Logo } from '../components/ui';
import { useAuth } from '../hooks/useAuth';

function Brand() {
  return (
    <aside className="auth__brand" aria-hidden="true">
      <Logo />
      <div className="auth__pitch">
        <h2>Short links that report back in real time.</h2>
        <ul>
          <li>
            <Icon name="activity" size={16} /> Redirects served cache-first from Redis
          </li>
          <li>
            <Icon name="users" size={16} /> Unique visitors with HyperLogLog
          </li>
          <li>
            <Icon name="shield" size={16} /> Rate limits, SSRF guards and hashed secrets
          </li>
        </ul>
      </div>
      <svg className="auth__pulse" viewBox="0 0 400 120" preserveAspectRatio="none">
        <path d="M0 70 H120 L150 30 L185 105 L215 50 L235 70 H400" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </aside>
  );
}

export function AuthPage({ mode }: { mode: 'login' | 'signup' }) {
  const { login, signup, status } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/app';
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [limited, setLimited] = useState<{ until: number; info: RateLimitInfo } | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === 'authenticated') return <Navigate to={from} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (mode === 'signup' && name.trim().length < 2) return setError('Tell us your name.');
    if (!/^\S+@\S+\.\S+$/.test(email)) return setError('Enter a valid email address.');
    if (mode === 'signup' && password.length < 10) return setError('Passwords need at least 10 characters.');
    if (!password) return setError('Enter your password.');
    setBusy(true);
    try {
      if (mode === 'login') await login(email.trim(), password);
      else await signup(name.trim(), email.trim(), password);
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.rateLimit) setLimited({ until: Date.now() + err.rateLimit.retryAfter * 1000, info: err.rateLimit });
      else setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const isLogin = mode === 'login';
  return (
    <div className="auth">
      <Brand />
      <main className="auth__panel" id="main">
        <div className="auth__card">
          <div className="auth__mobile-logo">
            <Logo />
          </div>
          <h1 className="auth__title">{isLogin ? 'Welcome back' : 'Create your account'}</h1>
          <p className="auth__sub">
            {isLogin ? 'Sign in to manage your links and analytics.' : 'Free, and it takes about ten seconds.'}
          </p>
          <form className="form" onSubmit={submit} noValidate>
            {limited && <RateLimitBanner until={limited.until} info={limited.info} />}
            {error && (
              <div className="banner banner--error" role="alert">
                <Icon name="alert" size={18} />
                <div>
                  <p>{error}</p>
                </div>
              </div>
            )}
            {!isLogin && (
              <div className="field">
                <label htmlFor="name">Name</label>
                <input id="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
            )}
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                autoComplete={isLogin ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-describedby={!isLogin ? 'password-hint' : undefined}
              />
              {!isLogin && (
                <p className="field__hint" id="password-hint">
                  At least 10 characters. Hashed with Argon2id.
                </p>
              )}
            </div>
            <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
              {busy ? 'Please wait…' : isLogin ? 'Sign in' : 'Create account'}
            </button>
          </form>
          <p className="auth__switch">
            {isLogin ? (
              <>
                New here? <RouterLink to="/signup">Create an account</RouterLink>
              </>
            ) : (
              <>
                Already have an account? <RouterLink to="/login">Sign in</RouterLink>
              </>
            )}
          </p>
          {isLogin && (
            <p className="auth__demo">
              <Icon name="info" size={14} /> Demo: <code>demo@linkpulse.dev</code> / <code>demo-password-123</code>
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
