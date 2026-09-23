import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, Link as RouterLink } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { EmptyState } from './components/ui';
import { AuthProvider } from './hooks/useAuth';
import { ToastProvider } from './hooks/useToast';
import { ApiKeys } from './pages/ApiKeys';
import { AuthPage } from './pages/Auth';
import { Dashboard } from './pages/Dashboard';
import { LinkDetail } from './pages/LinkDetail';
import { PublicStats } from './pages/PublicStats';

const TITLES: [RegExp, string][] = [
  [/^\/login/, 'Sign in'],
  [/^\/signup/, 'Create account'],
  [/^\/app\/keys/, 'API keys'],
  [/^\/app\/links\//, 'Link analytics'],
  [/^\/app/, 'Links'],
  [/^\/stats\//, 'Public stats'],
];

/** Updates the document title per route and moves focus to <main> for screen-reader users. */
function RouteEffects() {
  const { pathname } = useLocation();
  useEffect(() => {
    const t = TITLES.find(([re]) => re.test(pathname))?.[1];
    document.title = t ? `${t} · LinkPulse` : 'LinkPulse';
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function NotFound() {
  return (
    <div className="center-screen">
      <EmptyState
        icon="link"
        title="Page not found"
        action={
          <RouterLink to="/app" className="btn btn--primary">
            Go to dashboard
          </RouterLink>
        }
      >
        Nothing lives at this address.
      </EmptyState>
    </div>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/app" replace />} />
      <Route path="/login" element={<AuthPage mode="login" />} />
      <Route path="/signup" element={<AuthPage mode="signup" />} />
      <Route path="/stats/:code" element={<PublicStats />} />
      <Route path="/app" element={<AppShell />}>
        <Route index element={<Dashboard />} />
        <Route path="links/:id" element={<LinkDetail />} />
        <Route path="keys" element={<ApiKeys />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <RouteEffects />
      <ToastProvider>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
