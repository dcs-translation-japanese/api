/**
 * コミット固定のツリーページ取得とページ分割。
 * @packageDocumentation
 */
import { createRoute, type RouteHandler, z } from '@hono/zod-openapi';
import { getRequiredEnvString } from '@/helpers/environmentHelper';
import type { AppEnv } from '@/types/env';
import { ProblemException } from '../../app';
import { issueTreeCursor, readTreeCursor } from '../../cursor';
import { getSnapshot, MAX_ITEMS, treeSnapshotSchema } from '../../snapshot';
import { failure, jsonMiddleware, pageSchema, readFailures } from '../common';

/** 実データからの1万件推計サイズに余裕を持たせた、公開ページ全体のJSONサイズ上限。 */
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
/** JSON応答とパスのUTF-8バイト数を計算する。 */
const encoder = new TextEncoder();
/** 固定コミットのファイル一覧に、全件取得の完了判定に使う継続情報を付ける。 */
const treePageSchema = treeSnapshotSchema.extend({ page: pageSchema }).openapi('TreeSnapshot');
/** tree専用のlimitとcursorだけを許可し、未定義のクエリを拒否する。 */
const treeQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(MAX_ITEMS).openapi({ default: MAX_ITEMS }).optional(),
  cursor: z.string().min(1).max(2048).optional(),
});

/** 認証不要の、同一コミットに固定したツリーページ。 */
export const getTree = createRoute({
  operationId: 'getTree',
  tags: ['Tree'],
  method: 'get',
  path: '/tree',
  description:
    '毎回全件取得する用途向け。limitは既定・最大10,000件、各ページのUTF-8 JSON応答は最大8 MiB。' +
    'サイズ上限によりlimit未満でも続きがあるため、page.nextCursorがnullになるまで同じlimitで取得し、完了後にのみ削除判定する。' +
    'cursorは取得開始から24時間有効で、全ページを同一コミットに固定する。' +
    'GET /v2/files・POST /v2/filesと、同じデータセンター・origin・リポジトリのキャッシュを共有する。' +
    '最新コミットは60秒、SHA固定のGitHubツリーは1年間キャッシュする（保持は保証しない）。' +
    'D1の登録済み更新日時は毎回取得し、応答全体はCache-Control: no-storeとする。' +
    'masterの変更反映は最大約60秒遅れ、別リクエスト間の同一コミットは保証しない。' +
    'master更新からD1反映までの数秒は、内容と更新日時がずれる場合がある。' +
    '全スナップショットは最大10,000件・UTF-8 JSON 20 MiB。上限超過は422 SNAPSHOT_LIMIT_EXCEEDED、' +
    'GitHubのツリー切り詰めは502とし、不完全な一覧は返さない。',
  security: [],
  middleware: jsonMiddleware,
  request: { query: treeQuerySchema },
  responses: {
    200: {
      description: 'コミット固定のツリーページ。nextCursorがnullなら取得完了。',
      content: { 'application/json': { schema: treePageSchema } },
    },
    ...readFailures,
    422: failure,
  },
});

/**
 * 件数・バイト数の両方で分割し、キャッシュが消えてもcursorのコミットから再構築する。
 * 最初の応答前に全体を検証し、最終ページではnextCursorをnullにする。
 * @param c 検証済みのクエリ・Workerバインディング・リクエストURLを持つコンテキスト。
 * @returns 固定コミットのツリーページを含む200のJSON応答。公開ページ自体はキャッシュしない。
 * @throws {ProblemException} cursor不正は400 INVALID_CURSOR、全体上限超過は422 SNAPSHOT_LIMIT_EXCEEDED。
 * @throws {HTTPException} GitHubの切り詰め・不正応答は502、依存先の利用不可・回数制限は503。
 */
export const getTreeHandler: RouteHandler<typeof getTree, AppEnv> = async (c) => {
  // updatedAtはコミットとは独立して更新されるため、公開応答自体はキャッシュしない。
  c.header('Cache-Control', 'no-store');
  const query = c.req.valid('query');
  const limit = query.limit ?? MAX_ITEMS;
  const secret = `${c.env.TARGET_GH_OWNER}/${c.env.TARGET_GH_REPO}\n${getRequiredEnvString('TARGET_GH_APP_PRIVATE_KEY', c.env.TARGET_GH_APP_PRIVATE_KEY)}`;
  const cursor = query.cursor ? await readTreeCursor(query.cursor, limit, secret) : undefined;
  const snapshot = await getSnapshot(c.env, undefined, {
    origin: new URL(c.req.url).origin,
    commitSha: cursor?.commitSha,
  });
  const start = cursor?.offset ?? 0;
  if (cursor && start >= snapshot.items.length) throw new ProblemException(400, 'INVALID_CURSOR');
  const { items: all, ...header } = snapshot;
  const items: typeof all = [];
  // 最大長のcursorを予約し、署名の生成をページ当たり1回に抑える。
  let bytes = encoder.encode(JSON.stringify({ ...header, items: [], page: { nextCursor: null } })).length + 2048;
  for (const item of all.slice(start, start + limit)) {
    const size = encoder.encode(JSON.stringify(item)).length + (items.length ? 1 : 0);
    if (bytes + size > MAX_PAGE_BYTES) break;
    bytes += size;
    items.push(item);
  }
  if (!items.length && all.length) throw new ProblemException(422, 'SNAPSHOT_LIMIT_EXCEEDED');
  const offset = start + items.length;
  const nextCursor =
    offset < all.length
      ? await issueTreeCursor(
          { commitSha: snapshot.commitSha, offset, limit, issuedAt: cursor?.issuedAt ?? Date.now() },
          secret,
        )
      : null;
  return c.json({ ...header, items, page: { nextCursor } }, 200);
};
