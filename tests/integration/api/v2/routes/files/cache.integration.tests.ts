/** tree・files間のCache API共有と、キャッシュ利用中のメタデータ・エラー応答を検証する。 */
import { describe, expect, it, vi } from 'vitest';
import { expectV2Contract } from '../../../../../helpers/v2Contract';
import { blob, createTestBindings, mocks, request, sha } from '../../../../../helpers/v2Read';

vi.mock('octokit', async () => (await import('../../../../../helpers/v2Read')).octokitMock);
vi.mock('@/services/treePathUpdatedAtService', async () => (await import('../../../../../helpers/v2Read')).metadataMock);

const prefix = 'https://api.dcs-translation-japanese.workers.dev/__tree-cache/v1/test-owner/test-repo/';
const operations = ['getTree', 'getFiles', 'queryFiles'] as const;
type Operation = (typeof operations)[number];

/** 同じパスを3つの公開読み取り操作から取得する。 */
const read = (operation: Operation): Promise<Response> => {
  if (operation === 'getTree') return request('/tree');
  if (operation === 'getFiles') return request('/files?path=DCSWorld/a.lua');
  return request('/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: ['DCSWorld/a.lua'] }),
  });
};

/** キャッシュキーを維持したまま、内部の有効期限・破損を再現する。 */
const store = async (key: string, value: unknown, expiresAt: number): Promise<void> => {
  await (await caches.open('v2-tree')).put(
    prefix + key,
    Response.json({ expiresAt, value }, { headers: { 'Cache-Control': 'public, max-age=31536000' } }),
  );
};

describe('tree and files shared cache', () => {
  it.each(operations)('shares cache populated by %s with both other operations and reloads D1 each time', async (first) => {
    for (const [index, operation] of [first, ...operations.filter((op) => op !== first)].entries()) {
      const updatedAt = `2026-02-0${index + 1}T00:00:00.000Z`;
      mocks.metadata.mockResolvedValue({ 'DCSWorld/a.lua': new Date(updatedAt) });
      const response = await read(operation);
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      const body = await expectV2Contract(response, operation);
      expect(body).toMatchObject({
        commitSha: sha,
        [operation === 'getTree' ? 'items' : 'files']: [{ path: 'DCSWorld/a.lua', updatedAt }],
      });
      expect(mocks.branch).toHaveBeenCalledOnce();
      expect(mocks.tree).toHaveBeenCalledOnce();
      expect(mocks.metadata).toHaveBeenCalledTimes(index + 1);
    }
  });

  it('stores the documented TTLs and reloads the immutable tree at its one-year expiry', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect((await read('getFiles')).status).toBe(200);
      const cache = await caches.open('v2-tree');
      const head = await cache.match(`${prefix}branch/main`);
      const tree = await cache.match(`${prefix}tree/${sha}`);
      expect(head?.headers.get('Cache-Control')).toBe('public, max-age=60');
      expect(tree?.headers.get('Cache-Control')).toBe('public, max-age=31536000');
      expect(await head?.json()).toMatchObject({ expiresAt: now + 60000 });
      expect(await tree?.json()).toMatchObject({ expiresAt: now + 31536000000 });
      clock.mockReturnValue(now + 31536000000 - 1);
      expect((await read('queryFiles')).status).toBe(200);
      expect(mocks.tree).toHaveBeenCalledOnce();
      clock.mockReturnValue(now + 31536000000);
      expect((await read('getTree')).status).toBe(200);
      expect(mocks.tree).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  it.each(operations)('rechecks the head at 60 seconds but reuses the unchanged SHA tree via %s', async (operation) => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect((await read('getTree')).status).toBe(200);
      clock.mockReturnValue(now + 59999);
      expect((await read(operation)).status).toBe(200);
      expect(mocks.branch).toHaveBeenCalledOnce();
      clock.mockReturnValue(now + 60000);
      expect((await read(operation)).status).toBe(200);
      expect(mocks.branch).toHaveBeenCalledTimes(2);
      expect(mocks.tree).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
    }
  });

  it.each(['getFiles', 'queryFiles'] as const)('refreshes changed commits via %s after head expiry', async (operation) => {
    expect((await read('getTree')).status).toBe(200);
    await store('branch/main', sha, Date.now() - 1);
    const otherSha = 'b'.repeat(40);
    mocks.branch.mockResolvedValue({ data: { commit: { sha: otherSha } } });
    try {
      const response = await read(operation);
      expect(response.status).toBe(200);
      expect(await expectV2Contract(response, operation)).toMatchObject({ commitSha: otherSha });
      expect(mocks.branch).toHaveBeenCalledTimes(2);
      expect(mocks.tree).toHaveBeenLastCalledWith(expect.objectContaining({ tree_sha: otherSha }));
    } finally {
      await (await caches.open('v2-tree')).delete(`${prefix}tree/${otherSha}`);
    }
  });

  it.each(operations)('returns 503 rather than cached metadata when D1 fails via %s', async (operation) => {
    expect((await read('getTree')).status).toBe(200);
    mocks.metadata.mockRejectedValue(new Error('D1 unavailable'));
    const response = await read(operation);
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expectV2Contract(response, operation);
    expect(mocks.branch).toHaveBeenCalledOnce();
    expect(mocks.tree).toHaveBeenCalledOnce();
  });

  it.each(['getFiles', 'queryFiles'] as const)('recovers missing, corrupt and expired entries via %s', async (operation) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await read('getTree')).status).toBe(200);
      const cache = await caches.open('v2-tree');
      await cache.delete(`${prefix}tree/${sha}`);
      expect((await read(operation)).status).toBe(200);
      expect(mocks.tree).toHaveBeenCalledTimes(2);
      await store('branch/main', 'invalid-sha', Date.now() + 60000);
      await store(`tree/${sha}`, { truncated: true, tree: [blob()] }, Date.now() + 60000);
      expect((await read(operation)).status).toBe(200);
      expect(mocks.branch).toHaveBeenCalledTimes(2);
      expect(mocks.tree).toHaveBeenCalledTimes(3);
      await store(`tree/${sha}`, { truncated: false, tree: [blob()] }, Date.now() - 1);
      expect((await read(operation)).status).toBe(200);
      expect(mocks.tree).toHaveBeenCalledTimes(4);
    } finally {
      warn.mockRestore();
    }
  });

  it.each(['getFiles', 'queryFiles'] as const)(
    'fetches complete data when Cache API is unavailable via %s',
    async (operation) => {
      const cache = vi.spyOn(caches, 'open').mockRejectedValue(new Error('cache unavailable'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        for (let index = 0; index < 2; index++) {
          const response = await read(operation);
          expect(response.status).toBe(200);
          expect(await expectV2Contract(response, operation)).toMatchObject({ files: [{ path: 'DCSWorld/a.lua' }] });
        }
        expect(mocks.branch).toHaveBeenCalledTimes(2);
        expect(mocks.tree).toHaveBeenCalledTimes(2);
      } finally {
        cache.mockRestore();
        warn.mockRestore();
      }
    },
  );

  it.each(['getFiles', 'queryFiles'] as const)('does not fall back to stale data if GitHub fails via %s', async (operation) => {
    expect((await read('getTree')).status).toBe(200);
    await store('branch/main', sha, Date.now() - 1);
    mocks.branch.mockRejectedValue({ status: 503 });
    const response = await read(operation);
    expect(response.status).toBe(503);
    await expectV2Contract(response, operation);
    expect(mocks.metadata).toHaveBeenCalledOnce();
  });

  it('isolates repositories and origins from a warm cache', async () => {
    expect((await read('getTree')).status).toBe(200);
    const worker = (await import('@/index')).default;
    for (const [origin, repo] of [
      ['https://api.dcs-translation-japanese.workers.dev', 'another-repo'],
      ['https://localhost', 'test-repo'],
    ]) {
      const isolatedPrefix = `${origin}/__tree-cache/v1/test-owner/${repo}/`;
      const cache = await caches.open('v2-tree');
      await cache.delete(`${isolatedPrefix}branch/main`);
      await cache.delete(`${isolatedPrefix}tree/${sha}`);
      try {
        const response = await worker.fetch(
          new Request(`${origin}/v2/files?path=DCSWorld/a.lua`),
          createTestBindings({ TARGET_GH_REPO: repo, TREE_METADATA_DB: {} as D1Database }),
        );
        expect(response.status).toBe(200);
      } finally {
        await cache.delete(`${isolatedPrefix}branch/main`);
        await cache.delete(`${isolatedPrefix}tree/${sha}`);
      }
    }
    expect(mocks.branch).toHaveBeenCalledTimes(3);
    expect(mocks.tree).toHaveBeenCalledTimes(3);
  });
});
