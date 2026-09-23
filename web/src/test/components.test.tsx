import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { Analytics, Link } from '../api/types';
import { AnalyticsView } from '../components/AnalyticsView';
import { CreateLinkForm } from '../components/CreateLinkForm';
import { LinkTable } from '../components/LinkTable';

const link: Link = {
  id: '101',
  code: 'x7Kp2Qa',
  shortUrl: 'http://localhost:3501/x7Kp2Qa',
  url: 'https://example.com/spring-launch',
  title: 'Spring launch',
  faviconUrl: null,
  isCustom: false,
  hasPassword: true,
  expiresAt: null,
  maxClicks: 500,
  disabled: false,
  publicStats: false,
  clickCount: 1234,
  status: 'active',
  createdAt: '2026-09-01T10:00:00Z',
  updatedAt: '2026-09-01T10:00:00Z',
};

describe('CreateLinkForm', () => {
  it('shows field errors without calling the API when input is invalid', async () => {
    const onCreate = vi.fn();
    render(<CreateLinkForm onCreate={onCreate} onCreated={vi.fn()} baseUrl="http://localhost:3501" />);
    await userEvent.type(screen.getByLabelText('Destination URL'), 'javascript:alert(1)');
    await userEvent.type(screen.getByLabelText(/Custom alias/), 'no');
    await userEvent.click(screen.getByRole('button', { name: /shorten link/i }));
    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByText('Only http and https links can be shortened.')).toBeInTheDocument();
    expect(screen.getByLabelText('Destination URL')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/Use 3–32 letters/)).toBeInTheDocument();
  });

  it('submits a normalized payload and reports the created link', async () => {
    const onCreate = vi.fn().mockResolvedValue(link);
    const onCreated = vi.fn();
    render(<CreateLinkForm onCreate={onCreate} onCreated={onCreated} />);
    await userEvent.type(screen.getByLabelText('Destination URL'), 'example.com/spring-launch');
    await userEvent.click(screen.getByRole('button', { name: /shorten link/i }));
    expect(onCreate).toHaveBeenCalledWith({ url: 'https://example.com/spring-launch' });
    expect(onCreated).toHaveBeenCalledWith(link);
  });

  it('puts a 409 alias error next to the alias field', async () => {
    const onCreate = vi.fn().mockRejectedValue(new ApiError(409, 'alias_taken', 'That alias is already taken.'));
    render(<CreateLinkForm onCreate={onCreate} onCreated={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Destination URL'), 'https://example.com');
    await userEvent.type(screen.getByLabelText(/Custom alias/), 'launch');
    await userEvent.click(screen.getByRole('button', { name: /shorten link/i }));
    expect(await screen.findByText('That alias is already taken.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Custom alias/)).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows the rate-limit banner and disables submit during Retry-After', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const err = new ApiError(429, 'rate_limited', 'Too many requests', undefined, { retryAfter: 3, limit: 30, remaining: 0 });
    const onCreate = vi.fn().mockRejectedValue(err);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CreateLinkForm onCreate={onCreate} onCreated={vi.fn()} />);
    await user.type(screen.getByLabelText('Destination URL'), 'https://example.com');
    await user.click(screen.getByRole('button', { name: /shorten link/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/rate limit/i);
    expect(alert).toHaveTextContent(/Limit: 30 requests/);
    expect(screen.getByRole('button', { name: /try again in 3s/i })).toBeDisabled();

    await act(async () => {
      vi.advanceTimersByTime(3_500);
    });
    expect(screen.getByRole('button', { name: /shorten link/i })).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/try again now/i);
    vi.useRealTimers();
  });
});

describe('LinkTable', () => {
  it('renders one accessible row per link with status and click cap', () => {
    render(
      <MemoryRouter>
        <LinkTable links={[link, { ...link, id: '102', code: 'promo', status: 'disabled', disabled: true, maxClicks: null }]} onEdit={vi.fn()} onToggle={vi.fn()} onDelete={vi.fn()} />
      </MemoryRouter>,
    );
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(3); // header + 2
    const first = rows[1]!;
    expect(within(first).getByText('localhost:3501/x7Kp2Qa')).toBeInTheDocument();
    expect(within(first).getByText('1,234')).toBeInTheDocument();
    expect(within(first).getByText('/ 500')).toBeInTheDocument();
    expect(within(first).getByText('Active')).toBeInTheDocument();
    expect(within(first).getByRole('img', { name: 'Password protected' })).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Disabled')).toBeInTheDocument();
  });

  it('opens the row menu with the keyboard and offers enable for disabled links', async () => {
    const onToggle = vi.fn();
    const disabled = { ...link, status: 'disabled' as const, disabled: true };
    render(
      <MemoryRouter>
        <LinkTable links={[disabled]} onEdit={vi.fn()} onToggle={onToggle} onDelete={vi.fn()} />
      </MemoryRouter>,
    );
    screen.getByRole('button', { name: 'Actions for x7Kp2Qa' }).focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: /enable link/i }));
    expect(onToggle).toHaveBeenCalledWith(disabled);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});

describe('AnalyticsView', () => {
  it('summarises totals and renders ranked breakdowns', () => {
    const data: Analytics = {
      linkId: '101',
      range: { from: '2026-09-17T00:00:00Z', to: '2026-09-23T12:00:00Z', bucket: 'day' },
      totals: { clicks: 840, uniqueVisitors: 512, bots: 60 },
      timeseries: [
        { t: '2026-09-22T00:00:00Z', clicks: 400 },
        { t: '2026-09-23T00:00:00Z', clicks: 440 },
      ],
      referrers: [
        { name: 'news.ycombinator.com', clicks: 500 },
        { name: 'direct', clicks: 340 },
      ],
      countries: [{ name: 'TN', clicks: 300 }],
      browsers: [{ name: 'Chrome', clicks: 600 }],
      os: [{ name: 'Android', clicks: 420 }],
      devices: [{ name: 'mobile', clicks: 520 }],
    };
    render(<AnalyticsView data={data} liveExtra={3} />);
    expect(screen.getByText('843')).toBeInTheDocument();
    expect(screen.getByText('+3 live since page load')).toBeInTheDocument();
    expect(screen.getByText('512')).toBeInTheDocument();
    expect(screen.getByText('7% of raw traffic')).toBeInTheDocument();
    expect(screen.getByText('Direct / none')).toBeInTheDocument();
    expect(screen.getByText('Tunisia')).toBeInTheDocument();
    expect(screen.getByText('Mobile')).toBeInTheDocument();
    expect(screen.getByText(/840 clicks across 2 days, peaking at 440/)).toBeInTheDocument();
  });
});
