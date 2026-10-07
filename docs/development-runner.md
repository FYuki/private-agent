# 開発タスク（ローカル実行）

GUI `/development` と stdio MCP は同じ owner API を利用する。単発タスクを受け付け、計画、専用 worktree 編集、型検査・テスト、commit、private な同一リポジトリへの push と draft PR を順番に実行する。対象は管理側で固定した `FYuki/private-agent` / `epic/development-runner`。main へマージしない。

## モデルと認証

`orchestratorProfileId` と `executionProfileId` を別々に指定する。初期の利用可能な組合せは `plan-codex-luna` / `edit-codex-luna`（Codex 0.159.0、gpt-6-luna、既存 ChatGPT ログイン）。省略時の既定値は API/UI に明示する。Claude は `claude_profile_not_verified` として選択不可。任意の endpoint、実行パス、認証値をタスク入力から受け取らない。API課金への fallback はない。Core は任意で、この経路の依存ではない。

## 起動

既存の README のローカルNode/SQLite手順を済ませる。Linux の既存 `bwrap`、Codex、git、gh を用いる。新しい認証やトンネルを作らない。

```bash
export CONTROL_URL=http://127.0.0.1:8787/
export DEVELOPMENT_REPOSITORY=/absolute/path/to/private-agent
export DEVELOPMENT_WORKTREES=/absolute/path/to/dedicated-task-worktrees
export CODEX_PACKAGE=/absolute/path/to/node_modules/@openai/codex
export CODEX_AUTH_FILE=/absolute/path/to/existing/.codex/auth.json
# WORKER_TOKEN は .local/tokens.json のローカル用値をプロセス環境で渡す。
# 対象リポジトリへのpush/PRが利用者から許可されている場合だけ指定する。
export DEVELOPMENT_PUBLISH_AUTHORIZED=true
npm run worker:development
```

起動ごとに sandbox preflight を実行し、失敗時は利用不可を報告する。worker は外向き poll のみ、10秒ごとに能力と生存情報を送信する。30秒途絶えると UI に offline を表示する。常駐サービス登録は行わない。

dot用のプロセス起動契約は `npm run mcp:development`。`CONTROL_URL` と owner専用 `VIEWER_TOKEN` を接続管理側から渡す。tools は `development_profiles/submit/status/cancel`。stdio MCP の実 transport 契約試験はあるが、dot 自体への登録・到達経路・本番認証は別の接続作業。dot から WSL の localhost に到達できるとは仮定しない。公開bind・無認証API・トンネル作成は行わない。

## 永続化と停止

既存 jobs/runs/attempts に task_kind と15分の有限予算を追加し、development_tasks/operations/workers を SQLite に保存する。定期 answer の60秒予算は変えない。物理モデルと認証グループの既存共有枠を使い、計画と編集を直列に行う。日次試行数、ownerのジョブ数、出力量の上限も継承する。

submit は owner+idempotency key で一意。同じキーの異なる入力は409。全操作は lease/owner/worker/token/キャンセル状態を確認して予約し、入力fingerprintと結果を記録する。二重完了は同一結果だけ許可する。外部書込の応答不明は branch SHA / 既存 draft PR と照合し、一致するときだけ成功にする。予約済み操作を自動再送しない。照合できなければ `operation_blocked`。期限切れ development run は失敗として停止し、編集を自動再実行しない。SQLiteの操作状態とリモートSHA/PRを人が照合してから、新規タスクの要否を判断する。

プロセス群の停止は独立した単調時計deadline guardとbwrapの親終了時停止で強制する。キャンセル時の枠は子プロセスclose確認まで保持し、worker消失時は15分予算+安全猶予まで保持する。モデル出力・テスト成功・exit 0 は外部操作の承認ではない。

## 隔離・データ取扱い

実行CLIは空のHOME、固定argv、専用worktree、読取専用依存だけをマウントする。GitHub/control tokenや元のHOMEを渡さず、`.git`を隠す。CLI自身の既存auth.jsonは読取専用マウントし、Codex子ツールのpermissionsでそのディレクトリと `/proc` の読取を禁止する。子ツールのnetworkは無効。テストはauthなし、独立network namespaceで実行する。

公開可能なのは許可されたソース領域のTS/JS、20ファイル・合計256 KiBまで。パストラバーサル、symlink、既知形式の秘密文字列を拒否する。依存manifest、CI設定、認証、raw log、会話、private-knowledgeはcommitしない。テスト前後の対象ファイル内容・mode・削除状態が同一のときだけcommitする。生のCLIイベント/stderrは保存しない。SQLiteには利用者のgoal/受入条件、短い計画、操作状態、commit SHAとPR URLを保存するため、認証されたownerだけに公開する。

## 検証と制約

- `npm run check && npm test && npm run build`
- `npm run db:local` と `scripts/development-integration.ts`：実ローカルSQLite、認証・重複・cancel・15分予算。
- `scripts/development-preflight.ts`：合成authの直接/proc読取拒否、外部書込・symlink脱出・ツールnetwork拒否、既存login状態。`--live` は小さな合成編集を実モデルで確認する。
- `scripts/development-live.ts --publish-authorized`：同じprivate repoの小さな実タスクをdraft PRまで実行する。明示的な実試験用でCIには含めない。
- `scripts/development-browser.ts`：既存ブラウザーを `BROWSER_PATH` で指定し、スマホ幅の選択・送信・cancel・logoutを確認する。

CodeRabbit の実レビューは契約と観測結果で判断し、summary/skipを完了に数えない。mainへの必須レビュー条件は変更しない。TAKT由来の観点を用いる独立read-onlyレビューは次の段階。runtime依存を追加せず、採用commit/ライセンス・base/head SHA・review profile・JSON出力契約を固定する。現在の `ReadOnlyReviewer` は拡張interfaceのみで合否ゲートではない。

## ロールバック

開発workerを停止し、未実行タスクをowner APIでcancelする。停止確認まで占有枠を手動解放しない。PRはdraftのまま閉じられる。mainは変更されない。既存answer workerは従来プロトコルのまま使用でき、developmentをclaimしない。DBを戻す場合はローカルSQLiteをバックアップ後、migration前のコピーへ戻す。作業worktree・SQLiteの操作記録は外部結果の照合が済むまで削除しない。旧基盤の本番D1作成・secret投入・deploy・cron有効化・アカウント課金は当時未実施。現行のローカル起動とDB移行は[ローカル運用](local-control.md)を参照する。
