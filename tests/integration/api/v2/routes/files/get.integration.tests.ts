import { describe, expect, it, vi } from 'vitest';
import { expectV2Contract } from '../../../../../helpers/v2Contract';
import { blob, mocks, request, sha } from '../../../../../helpers/v2Read';

vi.mock('octokit', async () => (await import('../../../../../helpers/v2Read')).octokitMock);
vi.mock('@/services/treePathUpdatedAtService', async () => (await import('../../../../../helpers/v2Read')).metadataMock);

describe('GET /v2/files', () => {
  it('preserves the requested file order', async () => {
    mocks.tree.mockResolvedValue({ data: { truncated: false, tree: [blob(), blob('UserMissions/b.lua')] } });
    const response = await request('/files?path=UserMissions/b.lua&path=DCSWorld/a.lua');
    expect(response.status).toBe(200);
    expect(await expectV2Contract(response, 'getFiles')).toMatchObject({
      files: [{ path: 'UserMissions/b.lua' }, { path: 'DCSWorld/a.lua' }],
    });
  });

  it('pins every download URL to the snapshot commit rather than the blob SHA', async () => {
    mocks.tree.mockResolvedValue({
      data: {
        truncated: false,
        tree: [
          { ...blob(), sha: 'b'.repeat(40) },
          { ...blob('UserMissions/b.lua'), sha: 'c'.repeat(40) },
        ],
      },
    });
    const response = await request('/files?path=DCSWorld/a.lua&path=UserMissions/b.lua');
    expect(response.status).toBe(200);
    expect(await expectV2Contract(response, 'getFiles')).toMatchObject({
      commitSha: sha,
      files: [
        { url: `https://raw.githubusercontent.com/test-owner/test-repo/${sha}/DCSWorld/a.lua` },
        { url: `https://raw.githubusercontent.com/test-owner/test-repo/${sha}/UserMissions/b.lua` },
      ],
    });
  });

  it('encodes special characters in download URLs', async () => {
    mocks.tree.mockResolvedValue({ data: { truncated: false, tree: [blob('DCSWorld/a #?.lua')] } });
    const response = await request('/files?path=DCSWorld/a%20%23%3F.lua');
    expect(response.status).toBe(200);
    expect(await expectV2Contract(response, 'getFiles')).toMatchObject({
      files: [{ url: `https://raw.githubusercontent.com/test-owner/test-repo/${sha}/DCSWorld/a%20%23%3F.lua` }],
    });
  });

  it('returns JSON metadata rather than a file download', async () => {
    const response = await request('/files?path=DCSWorld/a.lua');
    expect(response.status).toBe(200);
    expect(await expectV2Contract(response, 'getFiles')).toEqual({
      commitSha: sha,
      generatedAt: expect.any(String),
      files: [
        {
          path: 'DCSWorld/a.lua',
          sha,
          size: 12,
          updatedAt: '2026-01-01T01:02:03.004Z',
          url: `https://raw.githubusercontent.com/test-owner/test-repo/${sha}/DCSWorld/a.lua`,
        },
      ],
    });
    expect(response.headers.get('Content-Disposition')).toBeNull();
  });

  it.each(['DCSWorld/missing.lua', 'DCSWorld/directory'])('returns only 404 if %s is included', async (path) => {
    mocks.tree.mockResolvedValue({
      data: { truncated: false, tree: [blob(), { ...blob('DCSWorld/directory'), type: 'tree', mode: '040000' }] },
    });
    const response = await request(`/files?path=DCSWorld/a.lua&path=${path}`);
    expect(response.status).toBe(404);
    expect(await expectV2Contract(response, 'getFiles')).not.toHaveProperty('files');
  });
});
