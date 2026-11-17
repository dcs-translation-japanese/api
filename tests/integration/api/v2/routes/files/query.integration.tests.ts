import { describe, expect, it, vi } from 'vitest';
import { expectV2Contract } from '../../../../../helpers/v2Contract';
import { blob, mocks, request, sha } from '../../../../../helpers/v2Read';

vi.mock('octokit', async () => (await import('../../../../../helpers/v2Read')).octokitMock);
vi.mock('@/services/treePathUpdatedAtService', async () => (await import('../../../../../helpers/v2Read')).metadataMock);

/** 認証・送信元IPなしで、ファイルパスをJSON本文に指定する。 */
const query = (paths: unknown, init?: RequestInit): Promise<Response> =>
  request('/files/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
    ...init,
  });

describe('POST /v2/files/query', () => {
  it.each([1, 300, 10000])('returns all %i requested files in a single response', async (count) => {
    const paths = Array.from({ length: count }, (_, i) => `DCSWorld/${i}.lua`);
    mocks.tree.mockResolvedValue({ data: { truncated: false, tree: paths.map((path) => blob(path)) } });
    const response = await query(paths);
    expect(response.status).toBe(200);
    expect(await expectV2Contract(response, 'queryFiles')).toHaveProperty('files.length', count);
  });

  it('preserves the requested file order', async () => {
    mocks.tree.mockResolvedValue({ data: { truncated: false, tree: [blob('DCSWorld/a.lua'), blob('UserMissions/b.lua')] } });
    const response = await query(['UserMissions/b.lua', 'DCSWorld/a.lua']);
    expect(response.status).toBe(200);
    expect(await expectV2Contract(response, 'queryFiles')).toMatchObject({
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
    const response = await query(['DCSWorld/a.lua', 'UserMissions/b.lua']);
    expect(response.status).toBe(200);
    expect(await expectV2Contract(response, 'queryFiles')).toMatchObject({
      commitSha: sha,
      files: [
        { url: `https://raw.githubusercontent.com/test-owner/test-repo/${sha}/DCSWorld/a.lua` },
        { url: `https://raw.githubusercontent.com/test-owner/test-repo/${sha}/UserMissions/b.lua` },
      ],
    });
  });

  it('returns the GET-compatible JSON metadata format without file content or pagination', async () => {
    const response = await query(['DCSWorld/a.lua']);
    expect(response.status).toBe(200);
    expect(await expectV2Contract(response, 'queryFiles')).toEqual({
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
  });

  it('preserves registered update timestamps and returns null for unregistered files', async () => {
    mocks.tree.mockResolvedValue({ data: { truncated: false, tree: [blob(), blob('UserMissions/b.lua')] } });
    const response = await query(['DCSWorld/a.lua', 'UserMissions/b.lua']);
    expect(response.status).toBe(200);
    expect(await expectV2Contract(response, 'queryFiles')).toMatchObject({
      files: [{ updatedAt: '2026-01-01T01:02:03.004Z' }, { updatedAt: null }],
    });
  });

  it('encodes special characters in download URLs', async () => {
    mocks.tree.mockResolvedValue({ data: { truncated: false, tree: [blob('UserMissions/a #?.lua')] } });
    const response = await query(['UserMissions/a #?.lua']);
    expect(response.status).toBe(200);
    expect(await expectV2Contract(response, 'queryFiles')).toMatchObject({
      files: [{ url: `https://raw.githubusercontent.com/test-owner/test-repo/${sha}/UserMissions/a%20%23%3F.lua` }],
    });
  });

  it('ignores authentication headers on this public operation', async () => {
    const response = await query(['DCSWorld/a.lua'], {
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer invalid' },
    });
    expect(response.status).toBe(200);
    await expectV2Contract(response, 'queryFiles');
  });

  it('is not subject to the write rate limiter', async () => {
    for (let i = 0; i < 11; i++) {
      const response = await query(['DCSWorld/a.lua']);
      expect(response.status).toBe(200);
      await expectV2Contract(response, 'queryFiles');
    }
  });

  it.each(
    [
      undefined,
      null,
      'DCSWorld/a.lua',
      [],
      [1],
      ['DCSWorld/a.lua', 'DCSWorld/a.lua'],
      Array.from({ length: 10001 }, (_, i) => `DCSWorld/${i}.lua`),
      ...[
        '',
        '/DCSWorld/a.lua',
        'DCSWorld/../a.lua',
        'DCSWorld/./a.lua',
        'DCSWorld//a.lua',
        'DCSWorld/.gitkeep',
        'DCSWorld/a\\b.lua',
        'DCSWorld/a\0.lua',
        'DCSWorld/a\u0085.lua',
        'README.md',
        `DCSWorld/${'a'.repeat(4088)}`,
        `DCSWorld/${'あ'.repeat(1363)}`,
      ].map((path) => [path]),
    ].map((paths) => ({ paths })),
  )('rejects invalid paths before contacting GitHub (case %#)', async ({ paths }) => {
    const response = await query(paths);
    expect(response.status).toBe(400);
    await expectV2Contract(response, 'queryFiles');
    expect(mocks.branch).not.toHaveBeenCalled();
  });

  it.each([
    ['/files/query?unknown=1', JSON.stringify({ paths: ['DCSWorld/a.lua'] }), 'application/json', 400],
    ['/files/query', JSON.stringify({ paths: ['DCSWorld/a.lua'], unknown: true }), 'application/json', 400],
    ['/files/query', '{', 'application/json', 400],
    ['/files/query', '', 'application/json', 400],
    ['/files/query', '{}', 'text/plain', 415],
    ['/files/query', '{}', '', 415],
  ])('rejects invalid bodies, queries or media types (case %#)', async (path, body, mediaType, status) => {
    const response = await request(path, { method: 'POST', headers: { 'Content-Type': mediaType }, body });
    expect(response.status).toBe(status);
    await expectV2Contract(response, 'queryFiles');
    expect(mocks.branch).not.toHaveBeenCalled();
  });

  it('rejects request bodies exceeding 5 MiB', async () => {
    const response = await query(['DCSWorld/a.lua'], { body: ' '.repeat(5 * 1024 * 1024 + 1) });
    expect(response.status).toBe(413);
    await expectV2Contract(response, 'queryFiles');
    expect(mocks.branch).not.toHaveBeenCalled();
  });

  it('guarantees 300 maximum-byte paths, including Unicode and JSON escaping', async () => {
    const paths = Array.from({ length: 300 }, (_, i) => `DCSWorld/${String(i).padStart(3, '0')}${'あ'.repeat(1359)}aa".lua`);
    expect(new TextEncoder().encode(paths[0]).length).toBe(4096);
    mocks.tree.mockResolvedValue({ data: { truncated: false, tree: paths.map((path) => blob(path)) } });
    const response = await query(paths);
    expect(response.status).toBe(200);
    await expectV2Contract(response, 'queryFiles');
  });

  it('returns 422 without partial results when the response exceeds 8 MiB', async () => {
    const paths = Array.from({ length: 1000 }, (_, i) => `DCSWorld/${i}/${'あ'.repeat(1000)}.lua`);
    mocks.tree.mockResolvedValue({ data: { truncated: false, tree: paths.map((path) => blob(path)) } });
    const response = await query(paths);
    expect(response.status).toBe(422);
    expect(await expectV2Contract(response, 'queryFiles')).toMatchObject({ code: 'SNAPSHOT_LIMIT_EXCEEDED' });
  });

  it.each(['DCSWorld/missing.lua', 'DCSWorld/directory'])('returns only 404 if %s is included', async (path) => {
    mocks.tree.mockResolvedValue({
      data: { truncated: false, tree: [blob(), { ...blob('DCSWorld/directory'), type: 'tree', mode: '040000' }] },
    });
    const response = await query(['DCSWorld/a.lua', path]);
    expect(response.status).toBe(404);
    const body = await expectV2Contract(response, 'queryFiles');
    expect(body).not.toHaveProperty('files');
  });

  it('rejects an unacceptable response media type', async () => {
    const response = await query(['DCSWorld/a.lua'], {
      headers: { 'Content-Type': 'application/json', Accept: 'application/zip' },
    });
    expect(response.status).toBe(406);
    await expectV2Contract(response, 'queryFiles');
  });

  it.each(['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE'])('rejects the unsupported %s method', async (method) => {
    const response = await request('/files/query', { method });
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
    if (method !== 'HEAD') await expectV2Contract(response, 'queryFiles');
  });

  it('returns a contract-valid error on upstream failure without leaking details', async () => {
    mocks.branch.mockRejectedValue({ status: 500, message: 'private upstream details' });
    const response = await query(['DCSWorld/a.lua']);
    expect(response.status).toBe(502);
    expect(JSON.stringify(await expectV2Contract(response, 'queryFiles'))).not.toContain('private upstream details');
  });
});
