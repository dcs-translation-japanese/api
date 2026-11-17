/** GitHubツリーとリクエストごとのD1更新日時を結合する、tree・files共通の読み取り処理。 */
import { z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import type { GitHubContext } from '@/services/githubService';
import { TreePathUpdatedAtService } from '@/services/treePathUpdatedAtService';
import type { Bindings } from '@/types/env';
import { dependencyUnavailable, ProblemException } from './app';
import { getGitHubContext } from './githubAdapter';
import { validRepositoryPath as validPath } from './paths';
import { dateTimeSchema, shaSchema } from './routes/common';
import { fileSchema, type filesSchema } from './routes/files/schemas';
import { loadTree } from './treeCache';

/** 想定最大1万件を、件数による分割なしで取得できる既定値兼全体上限。 */
export const MAX_ITEMS = 10000;
/** 全件検証・ソート・JSON生成のメモリ使用量を制限する内部スナップショットの上限。 */
const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;
const encoder = new TextEncoder();
/** 許可されたblobのファイル情報・mode・型を検証する公開スキーマ。 */
const treeItemSchema = z
  .strictObject({
    ...fileSchema.shape,
    mode: z.enum(['100644', '100755', '120000']),
    type: z.literal('blob'),
  })
  .openapi('TreeItem');

/** 全体を検証してからページ分割するためのスキーマ。 */
export const treeSnapshotSchema = z.strictObject({
  commitSha: shaSchema,
  generatedAt: dateTimeSchema,
  items: z.array(treeItemSchema).max(MAX_ITEMS),
});

/** 不正な依存先データを公開応答へ流さない。 */
const parseUpstream = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new HTTPException(502);
  return result.data;
};

/** パスの各セグメントをエンコードした、コミット固定のraw URLを作る。 */
const rawUrl = (ctx: GitHubContext, commit: string, path: string): string =>
  `https://raw.githubusercontent.com/${encodeURIComponent(ctx.owner)}/${encodeURIComponent(ctx.repo)}/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`;

/** tree・filesそれぞれの引数に対応する戻り値の型。 */
type GetSnapshot = {
  /**
   * 共有キャッシュから解決したコミットのファイルを、要求順で返す。
   * @param env GitHub接続設定とTREE_METADATA_DBを含むWorkerのバインディング。
   * @param paths 件数と重複条件を呼び出し元で検証済みのファイルパス。
   * @param options キャッシュキー用のリクエストorigin。
   * @returns 同じコミットのファイル情報と、毎回D1から取得した更新日時。
   * @throws {HTTPException} パス不正は400、対象不存在は404、依存先の障害は502または503。
   */
  (env: Bindings, paths: string[], options: { origin: string }): Promise<z.infer<typeof filesSchema>>;
  /**
   * 全ツリーをUTF-8パス順で返す。継続取得では指定コミットに固定する。
   * @param env GitHub接続設定とTREE_METADATA_DBを含むWorkerのバインディング。
   * @param paths 全件取得ではundefinedを指定する。
   * @param options キャッシュキー用originと、継続取得で固定する任意のコミットSHA。
   * @returns 件数・バイト数を検証済みの全件スナップショット。未登録の更新日時はnull。
   * @throws {ProblemException} 10,000件または内部JSON全体20 MiBの超過時は422 SNAPSHOT_LIMIT_EXCEEDED。
   * @throws {HTTPException} GitHubの切り詰め・不正応答は502、依存先の利用不可は503。
   */
  (
    env: Bindings,
    paths: undefined,
    options: { origin: string; commitSha?: string },
  ): Promise<z.infer<typeof treeSnapshotSchema>>;
};
/** 同一コミットのGitHubツリーと、各リクエスト時点の登録済み更新日時を結合する。 */
export const getSnapshot = (async (
  env: Bindings,
  paths: string[] | undefined,
  options: { origin: string; commitSha?: string },
): Promise<z.infer<typeof treeSnapshotSchema> | z.infer<typeof filesSchema>> => {
  if (paths && !paths.every(validPath)) throw new HTTPException(400);
  const ctx = await getGitHubContext(env);
  const { commitSha, tree } = await loadTree(ctx, options);
  const blobs = tree.tree.filter((item) => item.type === 'blob' && validPath(item.path));
  if (!paths && blobs.length > MAX_ITEMS) throw new ProblemException(422, 'SNAPSHOT_LIMIT_EXCEEDED');
  const byPath = paths ? new Map(blobs.map((item) => [item.path, item])) : undefined;
  const selected = paths
    ? paths.map((path) => {
        const item = byPath?.get(path);
        if (!item) throw new HTTPException(404);
        return item;
      })
    : blobs
        .map((item) => ({ item, bytes: encoder.encode(item.path) }))
        .sort((a, b) => {
          for (let i = 0; i < Math.min(a.bytes.length, b.bytes.length); i++) {
            const difference = (a.bytes[i] ?? 0) - (b.bytes[i] ?? 0);
            if (difference) return difference;
          }
          return a.bytes.length - b.bytes.length;
        })
        .map(({ item }) => item);
  if (!env.TREE_METADATA_DB) throw dependencyUnavailable();
  let updates: Record<string, Date | null>;
  try {
    updates = await new TreePathUpdatedAtService(env.TREE_METADATA_DB).read();
  } catch {
    throw dependencyUnavailable();
  }
  const snapshot = { commitSha, generatedAt: new Date().toISOString() };
  /** 選択したblobにコミット固定URLと最新の登録済み更新日時を付ける。 */
  const file = (item: (typeof selected)[number]): z.infer<typeof fileSchema> =>
    parseUpstream(fileSchema, {
      path: item.path,
      sha: item.sha,
      size: item.size,
      url: rawUrl(ctx, commitSha, item.path),
      updatedAt: updates[item.path]?.toISOString() ?? null,
    });
  if (paths) return { ...snapshot, files: selected.map(file) };
  const items: z.infer<typeof treeSnapshotSchema>['items'] = [];
  let bytes = encoder.encode(JSON.stringify({ ...snapshot, items: [] })).length;
  for (const item of selected) {
    const value = parseUpstream(treeItemSchema, { ...file(item), mode: item.mode, type: 'blob' });
    bytes += encoder.encode(JSON.stringify(value)).length + (items.length > 0 ? 1 : 0);
    if (bytes > MAX_SNAPSHOT_BYTES) throw new ProblemException(422, 'SNAPSHOT_LIMIT_EXCEEDED');
    items.push(value);
  }
  return { ...snapshot, items };
}) as GetSnapshot;
