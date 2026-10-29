import { describe, expect, it, vi } from 'vitest';
import app from '@/index';
import { createTestBindings } from '../../helpers/environment';

vi.mock('@/services/githubService', () => ({
  getIssues: vi.fn().mockResolvedValue([]),
}));

describe('migration submission stop', () => {
  it.each(['/create-pr', '/issue/create', '/issue/create/'])('blocks POST %s before side effects', async (path) => {
    const response = await app.fetch(
      new Request(`http://localhost${path}`, { method: 'POST' }),
      createTestBindings({ MIGRATION_READ_ONLY: 'true' }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ success: false });
  });

  it('keeps health available', async () => {
    const response = await app.fetch(
      new Request('http://localhost/health'),
      createTestBindings({ MIGRATION_READ_ONLY: 'true' }),
    );
    expect(response.status).toBe(200);
  });

  it('keeps POST issue listing available', async () => {
    const response = await app.fetch(
      new Request('http://localhost/issue/list', { method: 'POST' }),
      createTestBindings({ MIGRATION_READ_ONLY: 'true' }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: [] });
  });

  it.each(['/download-file-paths', '/tree-metadata/upsert'])(
    'does not replace validation or authorization on POST %s',
    async (path) => {
      const response = await app.fetch(
        new Request(`http://localhost${path}`, { method: 'POST' }),
        createTestBindings({ MIGRATION_READ_ONLY: 'true' }),
      );
      expect([400, 401, 403, 415, 422]).toContain(response.status);
    },
  );

  it.each([undefined, 'false'] as const)('allows normal validation when flag is %s', async (flag) => {
    const response = await app.fetch(
      new Request('http://localhost/create-pr', { method: 'POST' }),
      createTestBindings({ MIGRATION_READ_ONLY: flag }),
    );
    expect(response.status).toBe(400);
  });
});
