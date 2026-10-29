# DCS Translation Japanese Cloudflare Worker

[DCS TranslationJapanese](https://github.com/dcs-translation-japanese/translations) リポジトリの内容に対する参照・操作を提供する API サーバー。

## エンドポイント

- `/health`（疎通確認）
- `/tree`（リポジトリツリー取得）
- `/issue`
  - `/list`（GitHub の Issue 一覧を取得）
  - `/create`（GitHub の Issue を作成）
- `/create-pr`（ファイル差分から PR 作成）
- `/download-zip`（指定パスの ZIP 生成）
- `/download-file-paths` (指定パスの GitHub Raw URL一覧を返却)
- `/docs`（Swagger UI）

## Orgへの切り替えと公開条件

translationsのTransfer後、同じGitHub App（ID `2459818`）をOrgへインストールし、
対象はtranslationsだけに限定します。Contents・Issues・Pull requestsのread/writeを確認してください。
Org installation IDは移管後に実測し、既存の `cloudflare.config.ts` の値を置き換えてから取り込みます。
このPRの準備時点では移管前のIDが残っています。実測値への更新とCI確認を終えるまで取り込みません。

新旧CORS originの先行公開、通常PRマージの保留、App権限、保存済みPATの確認を済ませてから切り替えます。
公開には既存のGitHub Actionsを使用し、対象コミットを実行記録で確認します。
Worker名・公開URL・既存D1の2 binding・App ID・秘密鍵を維持し、本番DBの初期化は行いません。
失敗時は通常PRマージを保留し、新owner/repo・Org installation・新旧CORSを保ったまま修復します。

## 実行と開発手順

- 依存関係の導入: `pnpm install`
- ローカル開発サーバー: `pnpm dev`
- 本番エントリポイントでのローカル起動: `pnpm start`
- デプロイ前のビルド・設定確認: `pnpm run deploy --dry-run`
- 本番デプロイ: GitHub Actions（Release 公開時、または手動実行）
- 型定義生成: `pnpm cf-typegen`
- 静的検証: `pnpm check`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt`
- テスト実行: `pnpm test`

### Cloudflare CLI

Node.js 24 と pnpm 10 を使用します。Worker の設定は `cloudflare.config.ts`、
ビルドと開発サーバーの設定は `vite.config.mts` で管理しています。
cf と Cloudflare Vite プラグインは beta 版のため、動作確認済みのバージョンに固定しています。

`pnpm dev` は `src/index.dev.ts`、`pnpm start` とデプロイは `src/index.ts` を使用します。
開発サーバーの URL は `http://127.0.0.1:8787` です。
ローカルのシークレットは `.dev.vars` に設定してください（Git 管理対象外）。
ローカル D1 の既存データは自動移行されないため、必要に応じて初期化・移行してください。

`pnpm cf-typegen` は `.cloudflare/types/index.d.ts` を生成します。
設定変更時は再生成し、この型定義もコミットしてください。

本番への公開は既存のGitHub Actionsで実行します。
`CLOUDFLARE_ACCOUNT_ID`・`CLOUDFLARE_API_TOKEN`・`TARGET_GH_SECRET` は既存の
リポジトリシークレットを使用します。Appの既存秘密鍵は同じWorker上で維持します。
D1のID・Cron・Worker名は維持し、参照先owner/repoとinstallationだけを切り替えます。
PATの対象・期限・Org承認・Secretとの対応を設定で確認します。
移管後は既存のRelease Pleaseの実行結果で権限を確認し、CLI認証の成功をPATの検証に代用しません。

## サードパーティライセンス

本プロジェクトには、外部のオープンソースソフトウェアが含まれています。
各ライブラリのライセンス情報は以下のファイルに記載しています。

[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES/THIRD-PARTY-NOTICES.md)
