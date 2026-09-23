import { NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { Icon, type IconName } from './Icon';
import { ErrorState, Logo, Spinner } from './ui';

const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/app', label: 'Links', icon: 'link', end: true },
  { to: '/app/keys', label: 'API keys', icon: 'key' },
];

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p.charAt(0).toUpperCase())
      .join('') || '?'
  );
}

/** Authenticated layout: sidebar on desktop, compact top bar + tab row on phones. */
export function AppShell() {
  const { user, status, logout, error, retry } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  if (status === 'loading') {
    return (
      <div className="center-screen">
        <Spinner label="Loading your workspace" />
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="center-screen">
        <ErrorState message={error?.message ?? 'Could not reach the API.'} onRetry={retry} />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;

  const onLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        <NavLink to="/app" className="sidebar__brand" aria-label="LinkPulse home">
          <Logo />
        </NavLink>
        <nav className="sidebar__nav" aria-label="Main">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              // Link detail pages (/app/links/:id) belong to the "Links" section.
              className={({ isActive }) =>
                isActive || (item.to === '/app' && location.pathname.startsWith('/app/links/')) ? 'nav-item active' : 'nav-item'
              }
            >
              <Icon name={item.icon} size={18} />
              <span>{item.label}</span>
            </NavLink>
          ))}
          <a className="nav-item nav-item--docs" href="/docs" target="_blank" rel="noreferrer">
            <Icon name="book" size={18} />
            <span>API docs</span>
            <Icon name="external" size={13} className="nav-item__ext" />
          </a>
        </nav>
        <div className="sidebar__foot">
          <div className="user-chip">
            <span className="avatar" aria-hidden="true">
              {initials(user.name)}
            </span>
            <span className="user-chip__text">
              <span className="user-chip__name">{user.name}</span>
              <span className="user-chip__email">{user.email}</span>
            </span>
          </div>
          <button type="button" className="icon-btn" onClick={onLogout} aria-label="Sign out" title="Sign out">
            <Icon name="logout" size={17} />
          </button>
        </div>
      </aside>
      <main id="main" className="main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
