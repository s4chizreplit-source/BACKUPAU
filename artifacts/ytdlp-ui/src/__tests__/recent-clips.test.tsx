/**
 * Recent clips (device history) + useCloseOnBack.
 *
 * Covers:
 *  - saveRecentJob: newest-first ordering, RECENT_MAX cap, dedupe by id
 *  - loadRecentJobs: corrupt/absent localStorage data → []
 *  - ACCOUNT SCOPING: records belong to the account that made them — other
 *    accounts and signed-out visitors never see them
 *  - quota fallback: thumbnails stripped instead of throwing
 *  - deleteRecentJob / clearRecentJobs (clear only touches one account)
 *  - useCloseOnBack: phone Back button closes overlays without navigating
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

import { render } from '@testing-library/react';
import {
  loadRecentJobs,
  saveRecentJob,
  deleteRecentJob,
  clearRecentJobs,
  useCloseOnBack,
  RECENT_KEY,
  RECENT_MAX,
  type RecentJob,
} from '../pages/ClipperPage';

const OWNER = 'usr-a';

function makeJob(id: string, thumb = false, ownerId: string | undefined = OWNER): RecentJob {
  return {
    id,
    url: `https://youtube.com/watch?v=${id}`,
    platform: 'shorts',
    date: 1700000000000 + Number(id.replace(/\D/g, '') || 0),
    totalDuration: '21:03',
    ownerId,
    clips: [
      {
        id: `clip-${id}`,
        name: `clip-${id}.mp4`,
        label: `Clip ${id}`,
        startTime: '0:10',
        endTime: '0:40',
        duration: '0:30',
        size: 7_400_000,
        ...(thumb ? { thumbnailDataUrl: 'data:image/jpeg;base64,AAAA' } : {}),
      },
    ],
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recent clips local history', () => {
  it('saves newest first and caps the list at RECENT_MAX', () => {
    for (let i = 1; i <= RECENT_MAX + 2; i++) saveRecentJob(makeJob(String(i)));
    const jobs = loadRecentJobs(OWNER);
    expect(jobs).toHaveLength(RECENT_MAX);
    expect(jobs[0].id).toBe(String(RECENT_MAX + 2)); // newest first
    expect(jobs.some(j => j.id === '1')).toBe(false); // oldest dropped
    expect(jobs.some(j => j.id === '2')).toBe(false);
  });

  it('dedupes by id, moving the re-saved job to the front', () => {
    saveRecentJob(makeJob('a'));
    saveRecentJob(makeJob('b'));
    saveRecentJob(makeJob('a'));
    const jobs = loadRecentJobs(OWNER);
    expect(jobs.map(j => j.id)).toEqual(['a', 'b']);
  });

  it('scopes records to the account that made them', () => {
    saveRecentJob(makeJob('mine'));
    saveRecentJob(makeJob('theirs', false, 'usr-b'));
    // Legacy record from before owner-stamping — no ownerId at all.
    const legacy = { ...makeJob('legacy'), ownerId: undefined };
    saveRecentJob(legacy);

    // Each account sees only its own records.
    expect(loadRecentJobs(OWNER).map(j => j.id)).toEqual(['mine']);
    expect(loadRecentJobs('usr-b').map(j => j.id)).toEqual(['theirs']);
    // Signed out (or unknown owner) → nothing, even though the store has data.
    expect(loadRecentJobs()).toEqual([]);
    expect(loadRecentJobs(null)).toEqual([]);
    expect(loadRecentJobs('usr-c')).toEqual([]);
    // Ownerless legacy records are hidden from everyone — never leaked.
    expect(loadRecentJobs(OWNER).some(j => j.id === 'legacy')).toBe(false);
  });

  it('saveRecentJob returns only the owner’s records', () => {
    saveRecentJob(makeJob('other', false, 'usr-b'));
    const mine = saveRecentJob(makeJob('mine'));
    expect(mine.map(j => j.id)).toEqual(['mine']);
    // A job saved with no owner (signed out) is stored but returns [].
    // (Build then strip — passing `undefined` would trigger the default param.)
    expect(saveRecentJob({ ...makeJob('anon'), ownerId: undefined })).toEqual([]);
  });

  it('returns [] for corrupt or non-array stored data', () => {
    localStorage.setItem(RECENT_KEY, 'not json {{{');
    expect(loadRecentJobs(OWNER)).toEqual([]);
    localStorage.setItem(RECENT_KEY, '{"nope": true}');
    expect(loadRecentJobs(OWNER)).toEqual([]);
  });

  it('discards malformed entries (old schemas) instead of crashing', () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify([
      null,
      42,
      'string-entry',
      { id: 'no-url', clips: [{ id: 'c' }] },
      { url: 'https://no-id.com', clips: [{ id: 'c' }] },
      { id: 'no-clips', url: 'https://x.com' },
      { id: 'bad-clips', url: 'https://y.com', clips: [null, { noId: true }] },
      { id: 'ok', url: 'https://ok.com', ownerId: OWNER, clips: [null, { id: 'c1', size: 'huge' }] },
    ]));
    const jobs = loadRecentJobs(OWNER);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe('ok');
    expect(jobs[0].clips).toHaveLength(1);
    expect(jobs[0].clips[0].id).toBe('c1');
    expect(jobs[0].clips[0].size).toBe(0); // non-number size coerced to 0
    // Saving on top of the malformed store must not throw, and keeps only valid jobs
    expect(() => saveRecentJob(makeJob('fresh'))).not.toThrow();
    expect(loadRecentJobs(OWNER).map(j => j.id)).toEqual(['fresh', 'ok']);
  });

  it('strips thumbnails instead of throwing when localStorage quota is hit', () => {
    // jsdom's localStorage doesn't reliably route through a Storage.prototype
    // spy, so stub the whole global with a fake that fails the first two writes.
    const store: Record<string, string> = {};
    let failures = 2; // fail the first two attempts, then succeed
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => {
        if (k === RECENT_KEY && failures > 0) {
          failures--;
          throw new DOMException('quota', 'QuotaExceededError');
        }
        store[k] = v;
      },
      removeItem: (k: string) => { delete store[k]; },
      clear: () => { for (const k of Object.keys(store)) delete store[k]; },
      key: () => null,
      length: 0,
    });

    try {
      expect(() => saveRecentJob(makeJob('big', true))).not.toThrow();
      const jobs = loadRecentJobs(OWNER);
      expect(jobs).toHaveLength(1);
      // After both fallback rounds every thumbnail is stripped
      expect(jobs[0].clips[0].thumbnailDataUrl).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('deleteRecentJob removes one job; clearRecentJobs only empties one account', () => {
    saveRecentJob(makeJob('x'));
    saveRecentJob(makeJob('y'));
    saveRecentJob(makeJob('other', false, 'usr-b'));

    const afterDelete = deleteRecentJob('x', OWNER);
    expect(afterDelete.map(j => j.id)).toEqual(['y']);
    expect(loadRecentJobs(OWNER).map(j => j.id)).toEqual(['y']);

    // Clearing with no owner is a no-op — it must never nuke the device store.
    clearRecentJobs();
    expect(loadRecentJobs(OWNER).map(j => j.id)).toEqual(['y']);

    clearRecentJobs(OWNER);
    expect(loadRecentJobs(OWNER)).toEqual([]);
    // The other account's records survive.
    expect(loadRecentJobs('usr-b').map(j => j.id)).toEqual(['other']);
  });
});

describe('useCloseOnBack (phone Back button closes overlays)', () => {
  function Overlay({ onClose }: { onClose: () => void }) {
    useCloseOnBack(onClose);
    return <div>overlay</div>;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pushes a history entry on mount and closes on popstate without navigating again', () => {
    const push = vi.spyOn(window.history, 'pushState');
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    const onClose = vi.fn();
    const { unmount } = render(<Overlay onClose={onClose} />);
    expect(push).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(onClose).toHaveBeenCalledTimes(1);

    unmount(); // closed via Back → cleanup must NOT pop another entry
    expect(back).not.toHaveBeenCalled();
  });

  it('consumes its own history entry when closed via X/backdrop instead', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    const onClose = vi.fn();
    const { unmount } = render(<Overlay onClose={onClose} />);
    unmount(); // closed some other way → cleanup pops the entry it pushed
    expect(back).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});
