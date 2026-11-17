import { describe, expect, it, vi } from 'vitest';
import { expectV2Contract } from '../../../helpers/v2Contract';
import { issue, mocks, pr, request } from '../../../helpers/v2Read';

vi.mock('octokit', async () => (await import('../../../helpers/v2Read')).octokitMock);
vi.mock('@/services/treePathUpdatedAtService', async () => (await import('../../../helpers/v2Read')).metadataMock);

describe('Issue/PR keyset pagination', () => {
  it.each([
    ['/issues', mocks.issues, issue, 'listIssues'],
    ['/prs', mocks.prs, pr, 'listPullRequests'],
  ] as const)('%s traverses 1,000 items without rescanning from the first GitHub page', async (path, mock, item, operation) => {
    const entries = Array.from({ length: 1000 }, (_, i) => item(1000 - i, new Date(Date.UTC(2026, 0, 1, 0, -i)).toISOString()));
    mock.mockImplementation(async ({ page }: { page: number }) => ({ data: entries.slice((page - 1) * 100, page * 100) }));
    const numbers: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 50; page++) {
      const response = await request(`${path}?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      const body = (await expectV2Contract(response, operation)) as {
        items: { number: number }[];
        page: { nextCursor: string | null };
      };
      numbers.push(...body.items.map((entry) => entry.number));
      cursor = body.page.nextCursor;
      if (page < 49) expect(cursor).toBeTruthy();
    }
    expect(cursor).toBeNull();
    expect(numbers).toEqual(entries.map((entry) => entry.number));
    console.info(`${path}: 1,000 items / 50 requests / ${mock.mock.calls.length} GitHub calls`);
    expect(mock.mock.calls.length).toBeLessThanOrEqual(110);
  });

  describe.each([
    ['/issues', mocks.issues, issue, 'listIssues'],
    ['/prs', mocks.prs, pr, 'listPullRequests'],
  ] as const)('%s across changing GitHub pages', (path, mock, item, operation) => {
    it.each(['insertion', 'closure', 'reopening', 'empty hinted page'] as const)(
      'preserves the keyset boundary after %s',
      async (change) => {
        let entries = Array.from({ length: 400 }, (_, i) => item(400 - i, new Date(Date.UTC(2026, 0, 1, 0, -i)).toISOString()));
        mock.mockImplementation(async ({ page }: { page: number }) => ({
          data: entries.slice((page - 1) * 100, page * 100),
        }));
        let cursor: string | null = null;
        for (let page = 0; page < 3; page++) {
          const response = await request(`${path}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
          const body = (await expectV2Contract(response, operation)) as { page: { nextCursor: string } };
          cursor = body.page.nextCursor;
          expect(cursor).toBeTruthy();
        }
        const boundary = new Date(Date.UTC(2026, 0, 1, 0, -299)).toISOString();
        if (change === 'insertion') {
          entries.unshift(...Array.from({ length: 120 }, (_, i) => item(1000 + i, '2027-01-01T00:00:00Z')));
        } else if (change === 'closure') {
          entries = entries.slice(250);
        } else if (change === 'reopening') {
          entries.splice(300, 0, item(1000, entries[300]?.created_at));
        } else {
          entries = entries.slice(350);
        }
        const expected = entries
          .filter((entry) => entry.created_at < boundary)
          .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.number - a.number)
          .map((entry) => entry.number);
        const numbers: number[] = [];
        for (let page = 0; page < 5 && cursor; page++) {
          const response = await request(`${path}?limit=100&cursor=${encodeURIComponent(cursor)}`);
          const body = (await expectV2Contract(response, operation)) as {
            items: { number: number }[];
            page: { nextCursor: string | null };
          };
          numbers.push(...body.items.map((entry) => entry.number));
          cursor = body.page.nextCursor;
        }
        expect(cursor).toBeNull();
        expect(numbers).toEqual(expected);
      },
    );

    it('traverses timestamp ties spanning several pages, excluding PRs from issues', async () => {
      const entries = Array.from({ length: 360 }, (_, i) => ({
        ...item(i + 1, new Date(Date.UTC(2026, 0, 1, 0, -Math.floor(i / 120))).toISOString()),
        ...(path === '/issues' && i % 4 === 0 ? { pull_request: { url: 'https://api.github.com/repos/o/r/pulls/1' } } : {}),
      }));
      mock.mockImplementation(async ({ page }: { page: number }) => ({
        data: entries.slice((page - 1) * 100, page * 100),
      }));
      const expected = entries
        .filter((entry) => !('pull_request' in entry))
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.number - a.number)
        .map((entry) => entry.number);
      const numbers: number[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const response = await request(`${path}?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        const body = (await expectV2Contract(response, operation)) as {
          items: { number: number }[];
          page: { nextCursor: string | null };
        };
        numbers.push(...body.items.map((entry) => entry.number));
        cursor = body.page.nextCursor;
        if (!cursor) break;
      }
      expect(cursor).toBeNull();
      expect(numbers).toEqual(expected);
    });
  });

  it.each([
    ['/issues', mocks.issues, issue, 'listIssues'],
    ['/prs', mocks.prs, pr, 'listPullRequests'],
  ] as const)(
    '%s uses descending creation time and number, even for ties across GitHub pages',
    async (path, mock, item, operation) => {
      const first = Array.from({ length: 100 }, (_, i) => item(i + 1));
      mock.mockImplementation(async ({ page }: { page: number }) => ({ data: page === 1 ? first : [item(101)] }));
      const response = await request(`${path}?limit=2&state=all`);
      const body = (await expectV2Contract(response, operation)) as {
        items: { number: number }[];
        page: { nextCursor: string };
      };
      expect(body.items.map((entry) => entry.number)).toEqual([101, 100]);
      expect(body.page.nextCursor).toBeTruthy();
      const next = await request(`${path}?limit=2&state=all&cursor=${encodeURIComponent(body.page.nextCursor)}`);
      expect(await expectV2Contract(next, operation)).toMatchObject({ items: [{ number: 99 }, { number: 98 }] });
      expect(mock).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'all', sort: 'created', direction: 'desc', per_page: 100 }),
      );
    },
  );
});
