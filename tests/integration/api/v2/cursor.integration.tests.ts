import { describe, expect, it, vi } from 'vitest';
import { issueCursor } from '@/api/v2/cursor';
import { expectV2Contract } from '../../../helpers/v2Contract';
import { createTestBindings, issue, mocks, request } from '../../../helpers/v2Read';

vi.mock('octokit', async () => (await import('../../../helpers/v2Read')).octokitMock);
vi.mock('@/services/treePathUpdatedAtService', async () => (await import('../../../helpers/v2Read')).metadataMock);

describe('cursor validation', () => {
  const env = createTestBindings();
  const secret = `${env.TARGET_GH_OWNER}/${env.TARGET_GH_REPO}\n${env.TARGET_GH_APP_PRIVATE_KEY}`;
  const conditions = { resource: 'issues', state: 'open', limit: 1 } as const;
  const createdAt = new Date(issue().created_at).toISOString();

  it.each([undefined, 1, 2])('accepts signed cursors with page hint %s, including legacy cursors', async (page) => {
    mocks.issues.mockImplementation(async ({ page }: { page: number }) => ({
      data: page === 1 ? [issue(3), issue(2), issue(1)] : [],
    }));
    const cursor = await issueCursor(conditions, { createdAt, number: 3, page }, secret);
    const response = await request(`/issues?limit=1&cursor=${encodeURIComponent(cursor)}`);
    expect(await expectV2Contract(response, 'listIssues')).toMatchObject({ items: [{ number: 2 }] });
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])(
    'rejects a signed invalid page hint %s before GitHub access',
    async (page) => {
      const cursor = await issueCursor(conditions, { createdAt, number: 3, page }, secret);
      const response = await request(`/issues?limit=1&cursor=${encodeURIComponent(cursor)}`);
      expect(response.status).toBe(400);
      expect(await expectV2Contract(response)).toMatchObject({ code: 'INVALID_CURSOR' });
      expect(mocks.issues).not.toHaveBeenCalled();
    },
  );

  it('rejects malformed, altered, expired and condition-mismatched cursors', async () => {
    mocks.issues.mockResolvedValue({ data: [issue(2), issue(1)] });
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    try {
      const body = await (await request('/issues?limit=1')).json<{ page: { nextCursor: string } }>();
      const cursor = encodeURIComponent(body.page.nextCursor);
      for (const path of [
        '/issues?cursor=invalid',
        '/issues?cursor=',
        `/issues?cursor=${'a'.repeat(2049)}`,
        `/issues?limit=1&cursor=${cursor}x`,
        `/issues?limit=2&cursor=${cursor}`,
        `/issues?state=closed&limit=1&cursor=${cursor}`,
        `/prs?limit=1&cursor=${cursor}`,
      ]) {
        const response = await request(path);
        expect(response.status).toBe(400);
        expect(await expectV2Contract(response)).toMatchObject({ code: 'INVALID_CURSOR' });
      }
      clock.mockReturnValue(start + 24 * 60 * 60 * 1000);
      const expired = await request(`/issues?limit=1&cursor=${cursor}`);
      expect(expired.status).toBe(400);
      expect(await expectV2Contract(expired)).toMatchObject({ code: 'INVALID_CURSOR' });
    } finally {
      clock.mockRestore();
    }
  });
});
