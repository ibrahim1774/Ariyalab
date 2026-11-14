// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

vi.mock('next/router', () => ({ useRouter: () => ({ pathname: '/app/connections', asPath: '/app/connections' }) }));

const ConnectionsPage = (await import('../../pages/app/connections.js')).default;
const AppShell = (await import('../../components/app/AppShell.js')).default;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('/app/connections', () => {
  it('lists connected apps and disconnects one', async () => {
    let connections = [
      { clientId: 'c1', headline: 'Claude', verified: true, connectedAt: '2026-11-14T10:00:00.000Z', lastActiveAt: '2026-11-14T11:00:00.000Z' },
      { clientId: 'c2', headline: 'tools.example', verified: false, connectedAt: '2026-11-13T10:00:00.000Z', lastActiveAt: null },
    ];
    const fetchMock = vi.fn(async (url, init) => {
      if (init?.method === 'POST') {
        const { client_id } = JSON.parse(init.body);
        connections = connections.filter((c) => c.clientId !== client_id);
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return { ok: true, status: 200, json: async () => ({ connections }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<ConnectionsPage />);
    expect(await screen.findByText('Claude')).toBeInTheDocument();
    expect(screen.getByText('tools.example')).toBeInTheDocument();
    expect(screen.getByText('Unverified app')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /Disconnect/ })[0]);
    await waitFor(() => expect(screen.queryByText('Claude')).not.toBeInTheDocument());
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post[0]).toBe('/api/oauth/connections');
    expect(JSON.parse(post[1].body)).toEqual({ client_id: 'c1' });
    expect(post[1].headers['Content-Type']).toBe('application/json');
  });

  it('shows an empty state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ connections: [] }) })));
    render(<ConnectionsPage />);
    expect(await screen.findByText(/No apps are connected/)).toBeInTheDocument();
  });

  it('the sidebar has a Connected apps item', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    render(<AppShell><p>x</p></AppShell>);
    const link = screen.getByRole('link', { name: 'Connected apps' });
    expect(link).toHaveAttribute('href', '/app/connections');
    expect(link).toHaveAttribute('aria-current', 'page');
  });
});
