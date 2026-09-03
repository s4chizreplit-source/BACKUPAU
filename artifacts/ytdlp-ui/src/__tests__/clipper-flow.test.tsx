/**
 * Tests for the core clip flow on ClipperPage.
 *
 * Covers:
 *  - URL submission form validation (submit disabled for empty/invalid input,
 *    enabled for http(s) URLs, source-platform auto-detection, clear button)
 *  - Clip progress rendering: in-progress (spinner + rotating message, input
 *    locked), done (clips grid + header), and failed (error box + Try again)
 *  - Download button behavior: per-clip download link href/name + Saving/Saved
 *    feedback, and "Download All" ZIP request
 *  - Clip preview player (VideoModal): clean custom controls — no native
 *    browser bar (3-dot menu / timer), tap-to-play/pause, mute toggle
 */
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// ── Stub env before the module-level `API` constant is evaluated ─────────────
vi.stubEnv('VITE_API_URL', '');
vi.stubEnv('BASE_URL', '/');

// ClipperPage reads the signed-in user from ../lib/auth and navigates through
// wouter; both are stubbed so each test controls the auth state directly.
const { setLocationSpy, authState, SIGNED_IN_USER } = vi.hoisted(() => {
  const SIGNED_IN_USER = {
    id: 'usr_test',
    email: 'test@clipai.dev',
    name: 'Test Creator',
    role: 'user' as const,
    status: 'active' as const,
    plan: 'none' as const,
    planInterval: null,
    planStatus: 'none' as const,
    paidUntil: null,
    credits: {
      cutting: { subscription: 30, topup: 10, legacy: 2, total: 42 },
      uploading: { subscription: 3, topup: 0, legacy: 0, total: 3 },
    },
    createdAt: '2024-01-01T00:00:00Z',
  };
  return {
    setLocationSpy: vi.fn(),
    authState: { user: SIGNED_IN_USER as typeof SIGNED_IN_USER | null },
    SIGNED_IN_USER,
  };
});
vi.mock('wouter', () => ({
  useLocation: () => ['/', setLocationSpy],
  Link: ({ href, children, ...rest }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    user: authState.user,
    loading: false,
    refresh: vi.fn(async () => {}),
    login: vi.fn(),
    signup: vi.fn(),
    logout: vi.fn(),
  }),
  // ClipperPage's warm-on-paste debounce calls apiFetch after 800ms — without
  // this export the timer callback hits `undefined(...)` and vitest reports an
  // unhandled error when the timer outlives a test.
  apiFetch: vi.fn(async () => ({ ok: true, status: 202, json: async () => ({}) })),
}));
// The job-polling helper is exercised in isolation; here we control it.
vi.mock('../lib/clipJob', () => {
  class ClipJobCancelledError extends Error {
    constructor() { super('Job cancelled'); this.name = 'ClipJobCancelledError'; }
  }
  return {
    requestClips: vi.fn(),
    cancelClipJob: vi.fn(),
    ClipJobCancelledError,
    uploadVideoFile: vi.fn(),
    prettySource: (u: string) => u,
  };
});

// PricingCards uses useQueryClient — mock it out so the clipper tests don't
// need a full QueryClientProvider wrapper around ClipperPage.
vi.mock('../components/PricingCards', () => ({
  default: () => null,
}));

const { requestClips, cancelClipJob, ClipJobCancelledError } = await import('../lib/clipJob');
const ClipperPage = (await import('../pages/ClipperPage')).default;
const { VideoModal } = await import('../pages/ClipperPage');

const requestClipsMock = vi.mocked(requestClips);
const cancelClipJobMock = vi.mocked(cancelClipJob);

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const CLIPS = [
  {
    id: 'clip-1',
    name: 'clip-1.mp4',
    label: 'Clip 1',
    startTime: '0:10',
    endTime: '0:40',
    duration: '30s',
    size: 2_400_000,
    // Server-generated viral caption (only clip-1 — clip-2 mimics an old job).
    caption: 'Wait for it… 🤯\n\n#viral #trending #fyp #shorts',
  },
  {
    id: 'clip-2',
    name: 'clip-2.mp4',
    label: 'Clip 2',
    startTime: '1:05',
    endTime: '1:35',
    duration: '30s',
    size: 3_100_000,
  },
];

/** Mock global fetch with optional extra routes. */
function mockFetch(extra?: (url: string, init?: RequestInit) => Response | null) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const handled = extra?.(url, init as RequestInit);
    if (handled) return handled;
    throw new Error(`unexpected fetch: ${url}`);
  });
}

function urlInput() {
  // The single type="url" input in the hero form.
  return document.querySelector('input[type="url"]') as HTMLInputElement;
}

function submitButton() {
  return screen.getByRole('button', { name: /get clips/i });
}

/** Type a URL and submit the form. */
async function submitUrl(user: ReturnType<typeof userEvent.setup>, url: string) {
  const input = urlInput();
  await user.click(input);
  await user.paste(url);
  await user.click(submitButton());
}

beforeEach(() => {
  authState.user = SIGNED_IN_USER;
  setLocationSpy.mockReset();
  mockFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
  requestClipsMock.mockReset();
});

// ── URL submission form validation ───────────────────────────────────────────

describe('URL submission form', () => {
  it('disables submit for empty or non-http input and never calls the API', async () => {
    const user = userEvent.setup();
    render(<ClipperPage />);

    // Empty input → disabled.
    expect(submitButton()).toBeDisabled();

    // Non-URL text → still disabled.
    await user.click(urlInput());
    await user.paste('not a url');
    expect(submitButton()).toBeDisabled();

    // Submitting the form directly must also be a no-op.
    await user.keyboard('{Enter}');
    expect(requestClipsMock).not.toHaveBeenCalled();
  });

  it('enables submit once a http(s) URL is entered', async () => {
    const user = userEvent.setup();
    render(<ClipperPage />);

    await user.click(urlInput());
    await user.paste('https://www.youtube.com/watch?v=abc123');
    expect(submitButton()).toBeEnabled();
  });

  it('auto-detects the source platform from the pasted URL', async () => {
    const user = userEvent.setup();
    render(<ClipperPage />);

    await user.click(urlInput());
    await user.paste('https://kick.com/somechannel');

    // The Kick platform button becomes active (inline color style is applied).
    const kickBtn = screen.getByRole('button', { name: /kick/i });
    expect(kickBtn.getAttribute('style')).toContain('rgb');
  });

  it('submits the URL and settings to requestClips', async () => {
    requestClipsMock.mockResolvedValue({ clips: CLIPS, totalDuration: '12:34' });
    const user = userEvent.setup();
    render(<ClipperPage />);

    await submitUrl(user, 'https://youtu.be/xyz');

    await waitFor(() => expect(requestClipsMock).toHaveBeenCalledTimes(1));
    const [, body] = requestClipsMock.mock.calls[0];
    expect(body).toMatchObject({
      url: 'https://youtu.be/xyz',
      clipDuration: 30, // default duration
      clipCount: 5,     // default count
      platform: 'shorts', // default target platform
    });
  });

  it('clears the URL via the clear (X) button', async () => {
    const user = userEvent.setup();
    render(<ClipperPage />);

    await user.click(urlInput());
    await user.paste('https://youtu.be/xyz');
    expect(urlInput().value).toBe('https://youtu.be/xyz');

    // The clear button appears right after the input inside the input bar.
    const clearBtn = urlInput().parentElement!.querySelector(
      'button[type="button"]',
    ) as HTMLButtonElement;
    await user.click(clearBtn);
    expect(urlInput().value).toBe('');
    expect(submitButton()).toBeDisabled();
  });
});

// ── Subtitle style selection ──────────────────────────────────────────────────

describe('subtitle style selection', () => {
  it('defaults to captions ON with the "Default" tile — and sends no style', async () => {
    localStorage.clear();
    requestClipsMock.mockResolvedValue({ clips: CLIPS, totalDuration: '12:34' });
    const user = userEvent.setup();
    render(<ClipperPage />);

    // Toggle is on by default and the no-captions "Default" tile is visible.
    expect(screen.getByRole('switch', { name: /subtitles/i })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('No subtitles')).toBeInTheDocument();

    await submitUrl(user, 'https://youtu.be/xyz');
    await waitFor(() => expect(requestClipsMock).toHaveBeenCalledTimes(1));
    const [, body] = requestClipsMock.mock.calls[0];
    expect(body).toMatchObject({ subtitles: null });
  });

  it('sends the picked style once the user selects one', async () => {
    localStorage.clear();
    requestClipsMock.mockResolvedValue({ clips: CLIPS, totalDuration: '12:34' });
    const user = userEvent.setup();
    render(<ClipperPage />);

    await user.click(screen.getByRole('button', { name: /hormozi/i }));
    await submitUrl(user, 'https://youtu.be/xyz');

    await waitFor(() => expect(requestClipsMock).toHaveBeenCalledTimes(1));
    const [, body] = requestClipsMock.mock.calls[0];
    expect(body).toMatchObject({ subtitles: { style: 'hormozi' } });
  });

  it('keeps the style for existing users who already had captions on (v1 migration)', async () => {
    localStorage.clear();
    localStorage.setItem('autocliper_subs', JSON.stringify({ on: true, style: 'heat' }));
    requestClipsMock.mockResolvedValue({ clips: CLIPS, totalDuration: '12:34' });
    const user = userEvent.setup();
    render(<ClipperPage />);

    await submitUrl(user, 'https://youtu.be/xyz');
    await waitFor(() => expect(requestClipsMock).toHaveBeenCalledTimes(1));
    const [, body] = requestClipsMock.mock.calls[0];
    expect(body).toMatchObject({ subtitles: { style: 'heat' } });
  });
});

describe('campaign brief prompt', () => {
  it('shows detected caption requirements while keeping the full brief for clip selection', async () => {
    requestClipsMock.mockResolvedValue({ clips: CLIPS, totalDuration: '12:34' });
    const user = userEvent.setup();
    render(<ClipperPage />);

    const prompt = screen.getByLabelText(/what should we clip/i);
    await user.type(
      prompt,
      'Find surprising moments. Every caption must tag @BrandHQ, use #ad, and put the CTA in the first line.',
    );

    expect(screen.getByTestId('campaign-rules-feedback')).toHaveTextContent('@BrandHQ');
    expect(screen.getByTestId('campaign-rules-feedback')).toHaveTextContent('#ad');
    expect(screen.getByTestId('campaign-rules-feedback')).toHaveTextContent(/CTA first line/i);

    await submitUrl(user, 'https://youtu.be/xyz');
    await waitFor(() => expect(requestClipsMock).toHaveBeenCalledTimes(1));
    const [, body] = requestClipsMock.mock.calls[0];
    expect(body).toMatchObject({ prompt: expect.stringContaining('Find surprising moments') });
  });
});

// ── Clip progress rendering ───────────────────────────────────────────────────

describe('clip progress rendering', () => {
  it('shows the in-progress state while the job runs, then the results', async () => {
    let resolveJob!: (v: { clips: typeof CLIPS; totalDuration: string }) => void;
    requestClipsMock.mockImplementation(
      () => new Promise((res) => { resolveJob = res; }),
    );
    const user = userEvent.setup();
    render(<ClipperPage />);

    await submitUrl(user, 'https://youtu.be/xyz');

    // In-progress UI: rotating message + warning copy; input + submit locked.
    expect(await screen.findByText(/downloading video/i)).toBeInTheDocument();
    expect(screen.getByText(/don't close this tab/i)).toBeInTheDocument();
    expect(urlInput()).toBeDisabled();
    expect(submitButton()).toBeDisabled();

    // Job finishes → done state renders the clips.
    resolveJob({ clips: CLIPS, totalDuration: '12:34' });
    expect(await screen.findByText(/2 clips ready/i)).toBeInTheDocument();
    expect(screen.queryByText(/downloading video/i)).not.toBeInTheDocument();
    expect(screen.getByText(/from a 12:34 video/i)).toBeInTheDocument();
    expect(screen.getByText('Clip 1')).toBeInTheDocument();
    expect(screen.getByText('Clip 2')).toBeInTheDocument();
    // Sizes are formatted.
    expect(screen.getByText('2.4 MB')).toBeInTheDocument();
  });

  it('shows the viral caption and copies it in one tap', async () => {
    requestClipsMock.mockResolvedValue({ clips: CLIPS, totalDuration: '12:34' });
    const user = userEvent.setup();
    render(<ClipperPage />);
    await submitUrl(user, 'https://youtu.be/xyz');
    expect(await screen.findByText(/2 clips ready/i)).toBeInTheDocument();

    // Clip 1 carries a caption → text + copy button render; Clip 2 (an old
    // record without one) gets no caption UI.
    expect(screen.getByText(/wait for it/i)).toBeInTheDocument();
    const copyButtons = screen.getAllByRole('button', { name: /copy caption/i });
    expect(copyButtons).toHaveLength(1);

    // One tap copies the FULL caption (hook + hashtags), not just the visible
    // clamped lines.
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    await user.click(copyButtons[0]);
    expect(writeText).toHaveBeenCalledWith(CLIPS[0].caption);
    expect(await screen.findByText('Copied!')).toBeInTheDocument();
  });

  it('does not double-submit while a job is already loading', async () => {
    requestClipsMock.mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();
    render(<ClipperPage />);

    await submitUrl(user, 'https://youtu.be/xyz');
    expect(await screen.findByText(/downloading video/i)).toBeInTheDocument();

    // Try to submit again via the form (button is disabled; use Enter on form).
    const form = urlInput().closest('form')!;
    form.requestSubmit();
    await waitFor(() => expect(requestClipsMock).toHaveBeenCalledTimes(1));
  });

  it('shows the failed state with the job error and recovers via Try again', async () => {
    requestClipsMock.mockRejectedValue(
      new Error('Lost track of this job. Please try again.'),
    );
    const user = userEvent.setup();
    render(<ClipperPage />);

    await submitUrl(user, 'https://youtu.be/xyz');

    // Failed UI: heading + exact error message from the job layer.
    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();
    expect(
      screen.getByText(/lost track of this job\. please try again\./i),
    ).toBeInTheDocument();

    // "Try again" resets to the idle state.
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
    expect(urlInput().value).toBe('');
    // Back to the idle form, ready for a fresh run. (Marketing sections stay
    // hidden for signed-in users, so assert on the form itself.)
    expect(urlInput()).toBeEnabled();
  });

  it('shows a Cancel button while queued and leaves the line when clicked', async () => {
    cancelClipJobMock.mockResolvedValue(true);
    requestClipsMock.mockImplementation((_api, _body, opts) => {
      opts?.onJobId?.('job-123');
      opts?.onStatus?.({ status: 'queued', queuePosition: 2 });
      // Never settles on its own — cancellation aborts the wait.
      return new Promise((_res, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    const user = userEvent.setup();
    render(<ClipperPage />);

    await submitUrl(user, 'https://youtu.be/xyz');

    // Queue message + Cancel button are shown while waiting in line.
    expect(await screen.findByText(/2 jobs ahead of you/i)).toBeInTheDocument();
    const cancelBtn = await screen.findByRole('button', { name: /leave the line/i });

    await user.click(cancelBtn);
    expect(cancelClipJobMock).toHaveBeenCalledWith(expect.any(String), 'job-123');

    // Back to the idle form — no error, no spinner.
    await waitFor(() => expect(screen.queryByText(/jobs ahead of you/i)).not.toBeInTheDocument());
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
    expect(urlInput()).toBeEnabled();
  });

  it('hides the Cancel button once the job starts processing', async () => {
    requestClipsMock.mockImplementation((_api, _body, opts) => {
      opts?.onJobId?.('job-456');
      opts?.onStatus?.({ status: 'queued', queuePosition: 1 });
      return new Promise(() => {});
    });
    const user = userEvent.setup();
    render(<ClipperPage />);

    await submitUrl(user, 'https://youtu.be/xyz');
    expect(await screen.findByRole('button', { name: /leave the line/i })).toBeInTheDocument();

    // Server grants the slot → processing → cancel disappears.
    const opts = requestClipsMock.mock.calls[0][2];
    opts?.onStatus?.({ status: 'processing', queuePosition: 0 });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /leave the line/i })).not.toBeInTheDocument(),
    );
  });

  it('resets quietly when the job is cancelled from elsewhere', async () => {
    requestClipsMock.mockRejectedValue(new ClipJobCancelledError());
    const user = userEvent.setup();
    render(<ClipperPage />);

    await submitUrl(user, 'https://youtu.be/xyz');

    await waitFor(() => expect(urlInput()).toBeEnabled());
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
  });
});

// ── Credits & auth gating ─────────────────────────────────────────────────────

describe('credits & auth gating', () => {
  it('sends guests to login instead of submitting', async () => {
    authState.user = null;
    const user = userEvent.setup();
    render(<ClipperPage />);

    await submitUrl(user, 'https://youtu.be/xyz');

    expect(requestClipsMock).not.toHaveBeenCalled();
    expect(setLocationSpy).toHaveBeenCalledWith('/login?next=/');
  });

  it('shows credits in the avatar menu instead of a standalone nav chip', async () => {
    const user = userEvent.setup();
    render(<ClipperPage />);
    // No standalone credits chip in the top bar (user request — pill nav +
    // avatar menu cover it, phones included)
    expect(screen.queryByTitle(/your credits/i)).not.toBeInTheDocument();
    // Credits + top-up live inside the avatar menu
    await user.click(screen.getByRole('button', { name: /test creator/i }));
    expect(await screen.findByText(/42 cutting/i)).toBeInTheDocument();
  });

  it('shows "Not enough credits" with a View plans link on a 402', async () => {
    const err = new Error(
      'This job needs 250 credits (50 per clip) but you have 2. Top up or subscribe to continue.',
    ) as Error & { status?: number; code?: string };
    err.status = 402;
    err.code = 'INSUFFICIENT_CREDITS';
    requestClipsMock.mockRejectedValue(err);
    const user = userEvent.setup();
    render(<ClipperPage />);

    await submitUrl(user, 'https://youtu.be/xyz');

    expect(await screen.findByText(/not enough credits/i)).toBeInTheDocument();
    expect(screen.getByText(/needs 250 credits/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view plans/i })).toHaveAttribute('href', '/pricing');
  });

  it('nudges signed-in users with zero credits toward pricing', () => {
    authState.user = {
      ...SIGNED_IN_USER,
      credits: {
        cutting: { subscription: 0, topup: 0, legacy: 0, total: 0 },
        uploading: { subscription: 0, topup: 0, legacy: 0, total: 0 },
      },
    };
    render(<ClipperPage />);
    expect(screen.getByText(/out of cutting credits/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /get more/i })).toHaveAttribute('href', '/pricing');
  });
});

// ── Download button behavior ──────────────────────────────────────────────────

describe('download buttons', () => {
  async function renderDone(user: ReturnType<typeof userEvent.setup>) {
    requestClipsMock.mockResolvedValue({ clips: CLIPS, totalDuration: '12:34' });
    render(<ClipperPage />);
    await submitUrl(user, 'https://youtu.be/xyz');
    await screen.findByText(/2 clips ready/i);
  }

  it('renders a per-clip download link with the file URL and name', async () => {
    const user = userEvent.setup();
    await renderDone(user);

    const links = screen.getAllByRole('link', { name: /download/i });
    // 2 clip-card download buttons.
    const clip1Link = links.find(l => l.getAttribute('href')?.includes('clip-1'))!;
    expect(clip1Link).toBeTruthy();
    expect(clip1Link).toHaveAttribute('href', '/api/video/file/clip-1?download=1');
    expect(clip1Link).toHaveAttribute('download', 'clip-1.mp4');
  });

  it('shows Saving… then Saved! feedback after clicking Download', async () => {
    const user = userEvent.setup();
    await renderDone(user);

    const clip1Link = screen
      .getAllByRole('link', { name: /download/i })
      .find(l => l.getAttribute('href')?.includes('clip-1'))!;

    await user.click(clip1Link);
    expect(within(clip1Link as HTMLElement).getByText(/saving/i)).toBeInTheDocument();

    // After the feedback delay it flips to "Saved!".
    await waitFor(
      () => expect(within(clip1Link as HTMLElement).getByText(/saved!/i)).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it('Download All checks the ZIP endpoint with all clip ids', async () => {
    const user = userEvent.setup();
    // Re-mock fetch to also serve the ZIP availability check.
    vi.restoreAllMocks();
    const fetchMock = mockFetch((url) =>
      url.includes('/video/zip') ? jsonResponse({ ok: true }) : null,
    );
    await renderDone(user);

    await user.click(screen.getByRole('button', { name: /download all/i }));

    await waitFor(() => {
      const zipCall = fetchMock.mock.calls.find(([input]) =>
        String(input).includes('/video/zip'),
      );
      expect(zipCall).toBeTruthy();
      expect(String(zipCall![0])).toContain('ids=clip-1,clip-2');
      expect(String(zipCall![0])).toContain('check=1');
    });
  });

  it('falls back to per-file downloads when the ZIP check fails', async () => {
    const user = userEvent.setup();
    vi.restoreAllMocks();
    mockFetch((url) =>
      url.includes('/video/zip') ? jsonResponse({ error: 'nope' }, 500) : null,
    );
    await renderDone(user);

    // Spy on programmatic anchor clicks used by the staggered fallback.
    const clicked: string[] = [];
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicked.push(this.getAttribute('href') ?? '');
    };
    try {
      await user.click(screen.getByRole('button', { name: /download all/i }));
      await waitFor(
        () => {
          expect(clicked).toContain('/api/video/file/clip-1?download=1');
          expect(clicked).toContain('/api/video/file/clip-2?download=1');
        },
        { timeout: 3000 },
      );
    } finally {
      HTMLAnchorElement.prototype.click = origClick;
    }
  });
});

// ── Clip preview player (VideoModal) ──────────────────────────────────────────

describe('clip preview player', () => {
  const clip = CLIPS[0];

  /** jsdom does not implement media playback — stub play/pause. */
  function mockMedia() {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => {});
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    return { play, pause };
  }

  it('renders without the native browser controls (no 3-dot menu / timer bar)', () => {
    mockMedia();
    render(<VideoModal clip={clip} onClose={vi.fn()} />);

    const video = document.querySelector('video')!;
    expect(video).toBeTruthy();
    expect(video).not.toHaveAttribute('controls');
    // Custom minimal controls instead.
    expect(screen.getByRole('button', { name: /^play$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^mute$/i })).toBeInTheDocument();
  });

  it('tap toggles playback and the overlay follows real media events', async () => {
    const { play, pause } = mockMedia();
    const user = userEvent.setup();
    render(<VideoModal clip={clip} onClose={vi.fn()} />);

    // jsdom never autoplays → the play overlay is up; tapping it starts playback.
    await user.click(screen.getByRole('button', { name: /^play$/i }));
    expect(play).toHaveBeenCalledTimes(1);

    // Media reports "playing" → overlay goes away.
    const video = document.querySelector('video')!;
    fireEvent.play(video);
    expect(screen.queryByRole('button', { name: /^play$/i })).not.toBeInTheDocument();

    // Media is now un-paused; the full-surface toggle reads "Pause" (keyboard-reachable).
    vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockReturnValue(false);
    await user.click(screen.getByRole('button', { name: /^pause$/i }));
    expect(pause).toHaveBeenCalledTimes(1);

    // Media reports "paused" → overlay returns.
    fireEvent.pause(video);
    expect(screen.getByRole('button', { name: /^play$/i })).toBeInTheDocument();
  });

  it('mute button toggles sound', async () => {
    mockMedia();
    const user = userEvent.setup();
    render(<VideoModal clip={clip} onClose={vi.fn()} />);

    const video = document.querySelector('video') as HTMLVideoElement;
    expect(video.muted).toBe(false);

    await user.click(screen.getByRole('button', { name: /^mute$/i }));
    expect(video.muted).toBe(true);
    expect(screen.getByRole('button', { name: /^unmute$/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^unmute$/i }));
    expect(video.muted).toBe(false);
  });

  it('expired clip hides every player control', () => {
    mockMedia();
    render(<VideoModal clip={clip} onClose={vi.fn()} />);

    fireEvent.error(document.querySelector('video')!);

    expect(screen.getByText(/this clip has expired/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^play$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^mute$/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('seek-bar')).not.toBeInTheDocument();
  });

  it('clicking the seek strip jumps playback proportionally', () => {
    mockMedia();
    vi.spyOn(HTMLMediaElement.prototype, 'duration', 'get').mockReturnValue(30);
    render(<VideoModal clip={clip} onClose={vi.fn()} />);

    const strip = screen.getByTestId('seek-bar');
    vi.spyOn(strip, 'getBoundingClientRect').mockReturnValue({
      left: 0, width: 100, top: 0, right: 100, bottom: 6, height: 6, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);

    fireEvent.click(strip, { clientX: 50 });

    // The brand progress line reflects the 50% seek.
    const line = strip.firstElementChild!.firstElementChild as HTMLDivElement;
    expect(line.style.width).toBe('50%');
    const video = document.querySelector('video') as HTMLVideoElement;
    expect(video.currentTime).toBe(15);
  });
});
