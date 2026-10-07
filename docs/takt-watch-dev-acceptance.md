# Watch dev受入と実行契約

この変更はPR22の隔離dev/test用。通常runnerの`watch_runtime_validation_pending`、本番cron無効、公開承認境界を維持する。

## ジョブ枠とモデル

新規`takt-watch` taskはD1でplan系列Solの1枠と共有groupの1枠を予約する。coding、review、selectorは追加jobとして数えない。現対応はplanが`gpt-6-sol`または`gpt-6.1-sol`の構成だけで、Luna planは`plan_job_family_mismatch`としてモデル開始前に拒否する。Luna planを対応させる際は、受付側のprofileとworker側の解決結果をともに変更する。既存taskの予約値は書き換えない。

公式defaultのparallel reviewを保ち、外側CLI全体の直列lockを廃止した。短い排他区間で起動回数だけを原子的に予約し、各CLIは独立PID namespaceで実行する。最大60 CLI、1起動300秒、出力4MiB。全起動の終了を照合するまで成功を受理しない。起動失敗も消費済みとし、未確認lockを時間だけで奪わない。これはSDK内部のmodel request数の計測・課金上限ではない。

6.1 Sol xhighはwatchの許可済み候補へ追加し、従来simpleのallowlistは変えない。元`examples/takt/runtime.yaml`と工程別設定は変更していない。dev受入は提供v3の`live-isolated-runtime.yaml`をコピーし、SHA-256 `89140cbb8d83ca51a94ae3f2e471a219764a79531feb131514468b65a11fcefa`で束縛する。plan=6.1 Sol xhigh、coding/review=6 Sol medium、default/selector=Luna xhigh、assistant等はコピーの設定を維持する。

## dev専用入口

`scripts/watch-dev-acceptance.ts --live-authorized`は明示的な一件試験。通常runnerを有効にせず、実D1 API→lease→公式default→固定host検証→saveArtifact/finishArtifact→完了報告を使用する。合成Git、専用localhost認証、独立D1を新規作成する。既存IDの再実行は禁止。Git originは同一性契約のためだけに設定し、fetch/push/PR作成をしない。モデルの子ツールには通信・認証読取・Git操作権限を与えない。

起動には`WATCH_ACCEPTANCE_ID`、既存`CODEX_PACKAGE`、`CODEX_AUTH_FILE`と、承認済みの`WATCH_MAX_CLI`（1–60）、`WATCH_BUDGET_MS`（60000–3600000）を明示する。未指定では起動しない。ローカルテスト認証を本番へ流用しない。モデル実行前に既存ログイン、公式schema、plan系列を確認する。成功判定には固定hostのnpm check/testと5個の独立assertionが必要。提供済み成功証跡だけで今回の成功とは扱わない。

## 環境制約と受入記録

最初の実モデル試験`99e0ba11-2d5c-43c0-9087-ece138956bb1`は、公式0.68.0が絶対cloneパスをセッション保存名へ展開するため`ENAMETOOLONG`で失敗した。CLI起動1回（6.1 Sol）、175398ms。タイムアウトやモデル予算超過とは区別する。watch PID namespace終了、process group消滅、D1 failed/hold_until=0を確認した。生のmodel応答は公開しない。

このため保存先長を開始前に検査する。clone名80byteとatomic保存suffix57byteを予約し、255byteを超える設定を拒否する。再試験では短いWSL native `/tmp/paw-*`を使用したが、終了後にディレクトリが消失した。消失原因は未確定であり、WSL再起動と断定しない。今後はリポジトリ内の短い永続パス`.local/w/<4文字>`を使用し、所在と終了時のCLI件数・watch停止状態を専用devディレクトリへ記録する。元設定や公式sourceは改変しない。

再試験`2c755205-4334-426a-91ea-09e563f6e6b7`は消費済み1起動と3分を差し引いた59 CLI・57分・各300秒で実行した。**通し受入は未成功**。最後の観測は25分24秒、18起動・17終了、`development-core/replan`。その後adapterは`watch_task_failed`、D1はfailed/hold_until=0となった。公式runの最終理由と最終CLI件数は消失した一時ディレクトリにあり、確定できない。確認済み合計は前試験を含め19起動以上、設定による合計上限は60。残予算を推測して3回目の実モデル試験を始めていない。

モデルのimplementation reportでは、Git情報を隠した環境のため「タスク全体の変更ファイル一覧」が未確認だった。hostで同一snapshotの変更が指定2ファイルだけであること、npm check/testと独立assertion 5件の成功を確認し、公式`takt_tell_run`で同じrunへ1回配送した。snapshot hashは`197fdb288bdbc4ed5cb9b34e222d2685433ad640aa84554f677579b7dd1567b8`。配送受付は確認できたが、消費は未確認。これを公式default完了や成果物保存の成功には数えない。元runtimeコピーのhashは終了後も一致した。

`scripts/watch-host-evidence.ts`はこのdev限定の補助経路。固定2ファイルとpackage.jsonを独立sandboxへコピーし、検証前後のsnapshotが同じ場合だけ、同一running task/runへ事実を渡す。Git権限をモデルへ追加せず、公開の承認も与えない。再計画の最終判断がこの未確認項目だけに起因したかは、終端証跡喪失のため断定しない。

確定した残存証拠は`docs/evidence/takt-watch-dev-acceptance.json`。再開には、新しい一件に対する実行予算の明示が必要。具体的には、既存ChatGPTログインと同じ工程モデルで、独立localhost D1・合成Git・短い永続保存先を使う公式default一件（提案上限60分・60 CLI・各300秒）。前試験の残数が不明なため、以前の残予算として追加実行することはできない。main merge・deploy・本番ガード解除はこの再試験の承認にも含めない。

## 検証・ロールバック

単体回帰はジョブ枠、複数CLIの重なり、総起動上限、全起動終了照合、6.1 allowlist、Luna plan拒否、保存先長、取消時hold維持を確認する。CIはsecret不要の型検査・単体・dry-run build・公式reader・実ローカルD1/Workflowsを実行する。live受入はCIから起動しない。

戻す場合はこのPRを配備しないか、通常watchガードを維持したまま変更commitをrevertする。未完了taskや未確認holdをSQLで強制解放せず、元runnerの停止証明を先に確認する。main merge・deploy・サービス有効化・外部成果物公開は別承認のままである。

## 2026-10-07：専用worktreeでの再試験準備

PR22は引き続きDraft OPEN、head `70edffa639473aaba9a36904057daa67afe11116` のverify成功、親PR20はOPEN／verify成功をGitHubで再確認した。追加実モデル予算の承認は確認できていない。旧保存先 `/tmp/paw-65hRyO` は現在も存在せず、再試験の最終原因・最終件数は復元できない。残予算を推定しない。

T3専用worktreeの絶対パスでは、従来の `.local/w/<4文字>/<UUID>/clones` も保存名上限を超える。`WATCH_RUNS_PARENT` で短い永続データ領域を明示できるようにし、UUIDを含めた長さをD1受付・認証参照より前に検査する。作業worktreeの移動や既存worktreeの編集は行わない。v3 runtimeはコピーしたbytesの上記SHA-256一致を必須にした。

`--stub-provider` は実Codexのパス・認証を使わず、内蔵の失敗stubと偽認証を使う独立モード。上限2 CLI／90秒でD1受付→公式default→失敗→停止・永続記録を検証する。`--live-authorized` とは併用不可。成功経路は全中間commitで変更したパスが指定2ファイルだけであることもhostで確認する。

secret不要検証は型検査、124テスト、dry-run build、公式schema／reader／runtime設定／失敗stub、ローカルD1・Workflows統合が成功。D1付きdefault失敗stubは2件実施し、それぞれ2起動・2終了、watch停止、D1 failed／hold_until=0、入力hash維持と永続証跡を別プロセスで確認した。**実モデル呼出しは0回、実統合受入は未成功**。終了照合は `scripts/watch-dev-evidence-check.ts` を使い、stubの証跡をlive成功として受理しない。

### 次の一件（予算承認待ち）

- payload：合成Gitの `shared/greeting.js` と `tests/greeting.test.js` のみ変更。名前をtrimし、未指定・空・空白のみなら `Hello, world`。既存 `Ada` の互換性を保つ。正確なgoal／ACは受入scriptのspec、ローカル準備済み `.local/verification/live-request-proposal.json` に保存。
- 公式TAKT 0.68.0 defaultを1件。plan=6.1 Sol xhigh、coding/review=6 Sol medium、default/selector=Luna xhigh。runtimeの他設定は提供v3を維持。
- 提案上限：新規60分、合計60 CLI、各300秒。再試験の自動追加なし。SDK内部request数や金額の上限ではない。
- 保存先：実行データは `/home/asa/.local/paw/<新規4桁hex>`、D1・request・終了件数・artifactは専用worktreeの `.local/watch-acceptance/default-d1-20261007-01/`。既存ID・runを再使用しない。
- 通信：受入APIは `127.0.0.1:18797`、provider CLIは既存ChatGPTログインでCodexへ接続。モデルの子ツールは通信不可。Git originは同一性用でfetch/pushしない。

承認後に限り、専用worktreeで以下を実行する。現在の準備では実行していない。

```bash
export WATCH_ACCEPTANCE_ID=default-d1-20261007-01
export WATCH_RUNS_PARENT=/home/asa/.local/paw
export WATCH_MAX_CLI=60 WATCH_BUDGET_MS=3600000
export CODEX_PACKAGE=/home/asa/.nvm/versions/node/v24.15.0/lib/node_modules/@openai/codex
export CODEX_AUTH_FILE=/home/asa/.codex/auth.json
node --import tsx scripts/watch-dev-acceptance.ts --live-authorized
# 成功終了後、別プロセスで停止・件数・D1 hold・artifact hashを照合する。
node --import tsx scripts/watch-dev-evidence-check.ts
```

成功には公式defaultのAPPROVE伝播、固定host検証と独立assertion 5件、local-only artifact、全CLI終了照合、watch停止、D1 succeeded／hold_until=0をすべて要求する。host証跡配送を使う場合も同じ `WATCH_RUNS_PARENT` を明示する。配送受付だけを成功と扱わない。実行が失敗した場合は永続runの終端を調査し、新たな試験を無断で始めない。
