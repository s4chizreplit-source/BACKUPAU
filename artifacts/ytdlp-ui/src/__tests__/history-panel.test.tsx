/**
 * Tests for the HistoryPanel component (ClipperPage).
 *
 * Covers:
 *  - loading state: spinner shown while GET /history is in flight
 *  - empty state: "No clips yet" message when the server returns zero jobs
 *  - listing jobs: job rows rendered from GET /history response
 *  - deleting a job: X button calls DELETE /history/:id and removes the row
 *  - re-run callback: "Regenerate" populates the form via onRerun
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';

// ── Stub env before the module-level `API` constant is evaluated ─────────────
vi.stubEnv('VITE_API_URL', '');
vi.stubEnv('BASE_URL', '/');

// HistoryPanel lives in ClipperPage which imports wouter, the auth module and
// clipJob at module level; none are used by HistoryPanel itself, so stub them.
vi.mock('wouter', () => ({
  useLocation: () => ['/', vi.fn()],
  Link: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    user: null, loading: false, refresh: vi.fn(), login: vi.fn(), signup: vi.fn(), logout: vi.fn(),
  }),
  // ClipperPage module reads apiFetch — keep it callable so any stray debounce
  // timer can't hit `undefined(...)` after a test ends.
  apiFetch: vi.fn(async () => ({ ok: true, status: 202, json: async () => ({}) })),
}));
vi.mock('../lib/clipJob', () => ({
  requestClips: vi.fn(),
  cancelClipJob: vi.fn(),
  uploadVideoFile: vi.fn(),
  prettySource: (u: string) => u,
}));

const { HistoryPanel, sourceInfo } = await import('../pages/ClipperPage');
import type { RecentJob } from '../pages/ClipperPage';

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const JOBS = [
  {
    id: 'job-1',
    source_url: 'https://youtube.com/watch?v=aaa',
    platform: 'shorts',
    clip_duration: 30,
    clip_count: 3,
    total_duration: '5:00',
    created_at: '2024-01-15T10:00:00Z',
  },
  {
    id: 'job-2',
    source_url: 'https://twitch.tv/videos/123456789',
    platform: 'reels',
    clip_duration: 60,
    clip_count: 5,
    total_duration: '12:34',
    created_at: '2024-01-14T09:00:00Z',
  },
];

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Loading state ─────────────────────────────────────────────────────────────

describe('HistoryPanel — loading state', () => {
  it('shows a spinner while the history fetch is in flight', () => {
    // Never resolves — keeps the component in the loading state.
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));

    const onRerun = vi.fn();
    render(<HistoryPanel onRerun={onRerun} />);

    // The Loader2 icon renders as an svg; the parent div has animate-spin class.
    const spinner = document.querySelector('.animate-spin');
    expect(spinner).toBeTruthy();

    // Neither the empty state nor any job rows should be present yet.
    expect(screen.queryByText(/no clips yet/i)).not.toBeInTheDocument();
  });
});

// ── Empty state ───────────────────────────────────────────────────────────────

describe('HistoryPanel — empty state', () => {
  it('shows "No clips yet" when the server returns zero jobs', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ jobs: [] }),
    );

    render(<HistoryPanel onRerun={vi.fn()} />);

    expect(await screen.findByText(/no clips yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/regenerate/i)).not.toBeInTheDocument();
  });
});

// ── Listing jobs ──────────────────────────────────────────────────────────────

describe('HistoryPanel — listing jobs', () => {
  it('renders a row for every job returned by GET /history', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ jobs: JOBS }),
    );

    render(<HistoryPanel onRerun={vi.fn()} />);

    // Both source URLs (truncated) appear.
    expect(await screen.findByText(/youtube video/i)).toBeInTheDocument();
    expect(screen.getByText(/twitch video/i)).toBeInTheDocument();

    // Clip-count and duration metadata appear for each job.
    expect(screen.getByText(/3 clips · 30s/i)).toBeInTheDocument();
    expect(screen.getByText(/5 clips · 60s/i)).toBeInTheDocument();

    // A "Regenerate" button exists for each row.
    const regenBtns = screen.getAllByRole('button', { name: /regenerate/i });
    expect(regenBtns).toHaveLength(2);
  });
});

// ── Deleting a job ────────────────────────────────────────────────────────────

describe('HistoryPanel — deleting a job', () => {
  it('calls DELETE /history/:id and removes the row from the list', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';

      if (url.includes('/history') && method === 'GET') {
        return jsonResponse({ jobs: JOBS });
      }
      if (url.includes('/history/job-1') && method === 'DELETE') {
        return jsonResponse({ ok: true });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    const user = userEvent.setup();
    render(<HistoryPanel onRerun={vi.fn()} />);

    // Wait for rows to appear.
    await screen.findByText(/youtube video/i);

    // Two delete (X) buttons — click the first one (job-1).
    const xBtns = screen.getAllByRole('button', { name: /delete this session/i });
    await user.click(xBtns[0]);

    // DELETE was called with the right id.
    await waitFor(() => {
      const deleteCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url).includes('/history/job-1') &&
          (init as RequestInit)?.method === 'DELETE',
      );
      expect(deleteCall).toBeTruthy();
    });

    // The job-1 row is gone; job-2 row remains.
    expect(screen.queryByText(/youtube video/i)).not.toBeInTheDocument();
    expect(screen.getByText(/twitch video/i)).toBeInTheDocument();
  });
});

// ── Re-run callback ───────────────────────────────────────────────────────────

describe('HistoryPanel — re-run callback', () => {
  it('calls onRerun with the correct params when Regenerate is clicked', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ jobs: JOBS }),
    );

    const onRerun = vi.fn();
    const user = userEvent.setup();
    render(<HistoryPanel onRerun={onRerun} />);

    await screen.findByText(/youtube video/i);

    // Click Regenerate on the first job (job-1).
    const regenBtns = screen.getAllByRole('button', { name: /regenerate/i });
    await user.click(regenBtns[0]);

    expect(onRerun).toHaveBeenCalledTimes(1);
    expect(onRerun).toHaveBeenCalledWith(
      JOBS[0].source_url,
      JOBS[0].platform,
      JOBS[0].clip_duration,
      JOBS[0].clip_count,
    );
  });

  it("calls onRerun with the second job's params when its Regenerate is clicked", async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ jobs: JOBS }),
    );

    const onRerun = vi.fn();
    const user = userEvent.setup();
    render(<HistoryPanel onRerun={onRerun} />);

    await screen.findByText(/twitch video/i);

    const regenBtns = screen.getAllByRole('button', { name: /regenerate/i });
    await user.click(regenBtns[1]);

    expect(onRerun).toHaveBeenCalledWith(
      JOBS[1].source_url,
      JOBS[1].platform,
      JOBS[1].clip_duration,
      JOBS[1].clip_count,
    );
  });
});

// ── Device-copy twins hidden (merged History drawer) ─────────────────────────

const localTwin = (over: Partial<RecentJob>): RecentJob => ({
  id: 'local-1', url: 'https://example.com', platform: 'shorts',
  date: 0, totalDuration: '', clips: [], ...over,
});

describe('HistoryPanel — hides sessions already shown as device clips', () => {
  it('hides a job linked via historyId, keeps the rest', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ jobs: JOBS }));

    render(<HistoryPanel onRerun={vi.fn()} localJobs={[localTwin({ historyId: 'job-1' })]} />);

    expect(await screen.findByText(/twitch video/i)).toBeInTheDocument();
    expect(screen.queryByText(/youtube video/i)).not.toBeInTheDocument();
  });

  it('hides an unlinked job with the same URL clipped within 24h', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ jobs: JOBS }));

    const twin = localTwin({
      url: JOBS[1].source_url,
      date: Date.parse(JOBS[1].created_at) + 3600 * 1000, // 1h after the server row
    });
    render(<HistoryPanel onRerun={vi.fn()} localJobs={[twin]} />);

    expect(await screen.findByText(/youtube video/i)).toBeInTheDocument();
    expect(screen.queryByText(/twitch video/i)).not.toBeInTheDocument();
  });

  it('renders nothing when every session is already visible above', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ jobs: JOBS }));

    const { container } = render(<HistoryPanel onRerun={vi.fn()} localJobs={[
      localTwin({ historyId: 'job-1' }),
      localTwin({ id: 'local-2', historyId: 'job-2' }),
    ]} />);

    // No filler note, no header, no rows — the section disappears entirely.
    await waitFor(() => expect(container.firstChild).toBeNull());
    expect(screen.queryByRole('button', { name: /regenerate/i })).not.toBeInTheDocument();
  });
});

describe('HistoryPanel — twin matching edge cases', () => {
  it('handles numeric server ids and never matches malformed timestamps', async () => {
    const weird = [
      { ...JOBS[0], id: 101 as unknown as string },   // pg can return numeric ids
      { ...JOBS[1], created_at: 'not-a-date' },       // malformed timestamp
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ jobs: weird }));

    render(<HistoryPanel onRerun={vi.fn()} localJobs={[
      localTwin({ historyId: '101' }),
      localTwin({ id: 'local-2', url: JOBS[1].source_url, date: Date.parse(JOBS[1].created_at) }),
    ]} />);

    // Numeric id hidden via String() match; malformed-timestamp row must stay
    // visible (NaN can never satisfy the 24h window).
    expect(await screen.findByText(/twitch video/i)).toBeInTheDocument();
    expect(screen.queryByText(/youtube video/i)).not.toBeInTheDocument();
  });
});

// ── sourceInfo — friendly source labels ───────────────────────────────────────

describe('sourceInfo — friendly labels, never crashes on weird input', () => {
  it('extracts upload filenames and survives malformed %-encoding', () => {
    expect(sourceInfo('upload://abc123/My%20Video.mp4').label).toBe('My Video.mp4');
    // Invalid percent sequence must not throw — falls back to the raw segment.
    expect(sourceInfo('upload://abc123/bad%zzname.mp4').label).toBe('bad%zzname.mp4');
    expect(sourceInfo('upload://abc123/').label).toBe('Uploaded video');
  });

  it('labels YouTube URLs and normalizes ids from watch/shorts/short-link forms', () => {
    expect(sourceInfo('https://www.youtube.com/watch?v=aaa&t=5')).toMatchObject({
      label: 'YouTube video', sub: 'youtu.be/aaa', kind: 'youtube',
    });
    expect(sourceInfo('https://youtube.com/shorts/XYZ123').sub).toBe('youtu.be/XYZ123');
    expect(sourceInfo('https://youtu.be/ABC?si=tracking').sub).toBe('youtu.be/ABC');
  });

  it('labels Kick channels but not /video/ routes as channels', () => {
    expect(sourceInfo('https://kick.com/trainwreck').label).toBe('Kick · trainwreck');
    expect(sourceInfo('https://kick.com/video/12345').label).toBe('Kick video');
  });

  it('falls back gracefully for other hosts and non-URLs', () => {
    expect(sourceInfo('https://www.dropbox.com/scl/fo/xyz')).toMatchObject({ label: 'Dropbox video', kind: 'dropbox' });
    expect(sourceInfo('https://example.com/some/path').label).toBe('example.com');
    expect(sourceInfo('not a url at all')).toMatchObject({ label: 'not a url at all', kind: 'link' });
  });
});
