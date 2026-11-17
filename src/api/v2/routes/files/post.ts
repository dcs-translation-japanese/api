/** JSON本文で指定したファイルを、分割せず同一コミットから取得する読み取り操作。 */
import { createRoute, type RouteHandler, z } from '@hono/zod-openapi';
import type { AppEnv } from '@/types/env';
import { ProblemException } from '../../app';
import { getSnapshot } from '../../snapshot';
import { bodyMiddleware, emptyQuerySchema, failure, readFailures } from '../common';
import { filePathsSchema, fileSchema, filesSchema } from './schemas';

/** 管理対象の想定最大件数。 */
const MAX_FILES = 10000;
/** 単一JSON応答のメモリ使用量を、treeの公開ページと同じ8 MiBに制限する。 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();

/** GETと同じ応答形式結果を公開する。 */
const queriedFilesSchema = z
  .strictObject({ ...filesSchema.shape, files: z.array(fileSchema).min(1).max(MAX_FILES) })
  .openapi('QueriedFiles');

/** 認証・書き込み制限を要求しないファイル情報検索の公開契約。 */
export const queryFiles = createRoute({
  operationId: 'queryFiles',
  tags: ['Files'],
  method: 'post',
  path: '/files',
  description:
    'JSON本文のpathsに重複のない1〜10,000件を指定する。' +
    '本文は最大5 MiB、UTF-8 JSON応答は最大8 MiB。' +
    'GET /filesと同じパス検証・応答形式を使用し、全ファイルを同一コミットSHAに固定して指定順で返す。' +
    '認証不要の読み取り専用操作。存在しないパスは404、本文超過は413、' +
    '応答超過は422 SNAPSHOT_LIMIT_EXCEEDEDとし、分割・部分結果は返さない。' +
    'GET /v2/tree・GET /v2/filesと、同じデータセンター・origin・リポジトリのキャッシュを共有する。' +
    '最新コミットは60秒、SHA固定のGitHubツリーは1年間キャッシュする（保持は保証しない）。' +
    'D1の登録済み更新日時は毎回取得し、応答全体はCache-Control: no-storeとする。' +
    'masterの変更反映は最大約60秒遅れ、別リクエスト間の同一コミットは保証しない。' +
    '新規ファイルは反映まで404になる場合があり、master更新からD1反映までの数秒は内容と更新日時がずれる場合がある。',
  security: [],
  middleware: bodyMiddleware,
  request: {
    query: emptyQuerySchema,
    body: {
      required: true,
      content: { 'application/json': { schema: z.strictObject({ paths: filePathsSchema.max(MAX_FILES) }) } },
    },
  },
  responses: {
    200: { description: 'ファイル情報とダウンロードURL。', content: { 'application/json': { schema: queriedFilesSchema } } },
    ...readFailures,
    404: failure,
    413: failure,
    415: failure,
    422: failure,
  },
});

/** 指定順の全結果を取得し、応答サイズを検証してから単一のJSONを返す。 */
export const queryFilesHandler: RouteHandler<typeof queryFiles, AppEnv> = async (c) => {
  c.header('Cache-Control', 'no-store');
  const snapshot = await getSnapshot(c.env, c.req.valid('json').paths, { origin: new URL(c.req.url).origin });
  // 大きなJSON文字列を二重に保持せず、各ファイルのUTF-8サイズを合算する。
  let bytes = encoder.encode(JSON.stringify({ ...snapshot, files: [] })).length;
  for (const [index, file] of snapshot.files.entries()) {
    bytes += encoder.encode(JSON.stringify(file)).length + (index > 0 ? 1 : 0);
    if (bytes > MAX_RESPONSE_BYTES) throw new ProblemException(422, 'SNAPSHOT_LIMIT_EXCEEDED');
  }
  return c.json(snapshot, 200);
};
