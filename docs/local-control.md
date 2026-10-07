# ローカル制御基盤の運用

Node 24・Linuxで動く。Cloudflareのアカウント、Wrangler、workerd、D1、Cloudflare Workflowsは使用しない。公式TAKT workflowとwatch実行所有者は制御APIから独立している。

## 設定と起動

`npm run dev:setup`が`.local/control.json`と`.local/tokens.json`を0600で新規作成する。既存credential（旧`.dev.vars`を含む）があれば上書きせず拒否する。別の試験は`npm run dev:setup -- --directory <新規directory>`で隔離する。旧設定の読込fallbackはない。

`control.json`は`dbPath`（管理者指定のDBパス）、`authJson`（既存主体形式のJSON文字列）、`limits`（model/group容量）、省略可能な`port`（8787）、`scheduleEnabled`（false）、`watchAcceptanceEnabled`（false）を持つ。設定ファイルは秘密として管理する。DB親directoryは同一uid所有・他ユーザーから書込不可・symlinkなし。DBは0600の通常ファイル・同一uid所有・リンク数1。違反する既存ファイルはchmodせず拒否する。

```bash
npm run db:local -- --config /absolute/new/control.json
npm run dev -- --config /absolute/new/control.json --port 8787
```

両入口は同じ設定から同じDBへ接続する。`--db <path>`で変更する場合も両コマンドへ同じ値を渡す。migrationは0001〜0005のSQL本文とSHA-256・ファイル名を`local_migrations`へ同じ同期transactionで保存する。失敗時はschemaと履歴をrollbackする。適用済み本文の変更・不明な履歴・履歴のない既存schemaは拒否する。既存DBの初期化・探索・自動移動はない。

起動時は保存済みstartingだけを回収し、取消・disable・既実行runをqueuedへ戻さない。`scheduleEnabled:true`を明示した起動のみtimerが新しい予定時刻を受付ける。設定は起動時に解決する。サービス登録は行わない。tick応答の`ids`は保存済みrun ID、`GET /api/ticks/<run ID>`は同じownerの`{id,state}`を返す。

SIGINT/SIGTERMはHTTP受付停止→timer停止→進行中処理の終了待機→DB closeを行う。監視切断やAPI停止は独立watch実行の取消・hold解放を意味しない。取消はowner APIから要求し、元実行の停止ACKを確認する。

`x-local-measurement`の`statements`は正常終了したSQL呼出し数（batchはcommitしたstatement数）、`wallMs`はrequestの経過時間。未計測のrowsRead/rowsWrittenや課金CPUは出力しない。

## 生成成果物と隔離検証

`npm run build`は型検査の後、`dist`へJavaScriptとSQLを生成し、全JSの構文を検査する。`node dist/control-plane/local.js migrate|serve --config <path>`で元TSソースを使わず動作する。`npm test`の成果物試験は別directoryにコピーしてmigration・API・停止を確認する。

`npm run test:local`は新規`.local/integration-<ID>`の設定とDBを使用し、6統合scriptを実行する。`CONTROL_CONFIG`、`CONTROL_TOKENS`、`CONTROL_URL`、`CONTROL_EVIDENCE_DIR`を明示すると個別scriptも同じ接続を利用する。実時間試験は60秒間隔の2回、CLI/generic計4件をfixtureで確認し、証跡を隔離directoryへ保持する。実モデル・Core接続・外部公開は行わない。

watch失敗stubは`WATCH_ACCEPTANCE_ID=<新規ID> WATCH_RUNS_PARENT=<管理者が用意した短い永続directory> node --import tsx scripts/watch-dev-acceptance.ts --stub-provider`。提供runtimeのhash、公式default、通常guard、autoPr:falseを維持する。request/location/settlementに同じ絶対`dbPath`を記録する。終了後、同じIDで`node --import tsx scripts/watch-dev-evidence-check.ts --expect-stub-failure`を別processから実行する。確認器は記録されたDBだけをread-onlyで開き、終端・hold・provider件数・watch停止を照合する。DB欠落時に探索・新規作成しない。失敗stubは実モデル受入成功ではない。

## 旧ローカルD1からの手動移行

以下は管理者が合成コピーで検証したうえで明示実行する手順。実運用DBを自動移行しない。

1. 旧受付・scheduler・workerを止める。実行所有者の停止確認がないwatch予約を解放しない。旧DBとWAL等を稼働中に単純コピーしない。
2. 停止した旧DBにSQLite backup APIを使用して整合したバックアップを別保存先へ作る。元の`.wrangler`・`.local`と運用データを保存し、integrity_checkと件数を記録する。
3. バックアップから管理者が指定した新directoryの別DBへ明示コピーする。新DBだけを同一uid・0600、親を0700にする。元DB・credentialの権限や内容を変更しない。
4. 旧`d1_migrations`のファイル名・適用順と、その版のmigration SQL本文・schemaを照合する。列の存在だけから適用履歴を推測しない。不明なら停止して管理者が判断する。
5. 新コピーだけでtransactionを開始し、`CREATE TABLE local_migrations(name TEXT PRIMARY KEY,hash TEXT NOT NULL)`を作る。照合できた適用済みファイルごとに、その保全済みSQL本文のSHA-256とファイル名をINSERTしcommitする。旧履歴は保全する。
6. 新設定の`dbPath`を新コピーへ向け、`npm run db:local -- --config <新設定>`で未適用分だけを適用する。失敗時は新コピーを保全し、原因を調査する。再適用・API状態・保存件数・holdを照合してから切り替える。

rollbackは受付停止・worker停止確認の後、保全した成果物と整合したバックアップに戻す。DB削除や未確認holdの強制解放はしない。
