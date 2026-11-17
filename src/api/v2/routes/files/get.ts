/**
 * 指定ファイルの情報・コミット固定URLを返す操作の契約とハンドラー。
 * @packageDocumentation
 */
import { createRoute, type RouteHandler, z } from '@hono/zod-openapi';
import type { AppEnv } from '@/types/env';
import { getSnapshot } from '../../snapshot';
import { failure, jsonMiddleware, readFailures } from '../common';
import { filePathsSchema, filesSchema } from './schemas';

/** 重複のない1〜100件のpathを、繰り返しクエリとして受け付ける。 */
export const filesQuerySchema = z.strictObject({
  path: z.preprocess(
    (value) => (typeof value === 'string' ? [value] : value),

    filePathsSchema.max(100),
  ),
});

/** 認証不要のファイル情報取得操作のOpenAPI定義。 */
export const getFiles = createRoute({
  operationId: 'getFiles',
  tags: ['Files'],
  method: 'get',
  path: '/files',
  description:
    '指定したファイル情報とコミット固定URLを指定順で返す。' +
    'GET /v2/tree・POST /v2/filesと、同じデータセンター・origin・リポジトリのキャッシュを共有する。' +
    '最新コミットは60秒、SHA固定のGitHubツリーは1年間キャッシュする（保持は保証しない）。' +
    'D1の登録済み更新日時は毎回取得し、応答全体はCache-Control: no-storeとする。' +
    'masterの変更反映は最大約60秒遅れ、別リクエスト間の同一コミットは保証しない。' +
    '新規ファイルは反映まで404になる場合があり、master更新からD1反映までの数秒は内容と更新日時がずれる場合がある。',
  security: [],
  middleware: jsonMiddleware,
  request: { query: filesQuerySchema },
  responses: {
    200: { description: 'ファイル情報とダウンロードURL。', content: { 'application/json': { schema: filesSchema } } },
    ...readFailures,
    404: failure,
  },
});

/**
 * 指定されたパス順に、同じコミットのファイル情報とraw URLを返す。
 * @param c 検証済みpathとWorkerのバインディングを持つリクエストコンテキスト。
 * @returns コミット固定のファイル情報を含むJSON応答。
 * @throws {HTTPException} 不正なパスは400、存在しないファイルが1件でもあれば404。
 */
export const getFilesHandler: RouteHandler<typeof getFiles, AppEnv> = async (c) => {
  c.header('Cache-Control', 'no-store');
  const snapshot = await getSnapshot(c.env, c.req.valid('query').path, { origin: new URL(c.req.url).origin });
  return c.json(snapshot, 200);
};
