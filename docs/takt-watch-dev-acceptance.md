# Watch dev受入と実行契約

この変更はPR22の隔離dev/test用。通常runnerの`watch_runtime_validation_pending`、本番cron無効、公開承認境界を維持する。

## ジョブ枠とモデル

新規`takt-watch` taskはD1でplan系列Solの1枠と共有groupの1枠を予約する。coding、review、selectorは追加jobとして数えない。現対応はplanが`gpt-6-sol`または`gpt-6.1-sol`の構成だけで、Luna planは`plan_job_family_mismatch`としてモデル開始前に拒否する。Luna planを対応させる際は、受付側のprofileとworker側の解決結果をともに変更する。既存taskの予約値は書き換えない。

公式defaultのparallel reviewを保ち、外側CLI全体の直列lockを廃止した。短い排他区間で起動回数だけを原子的に予約し、各CLIは独立PID namespaceで実行する。最大60 CLI、1起動300秒、出力4MiB。全起動の終了を照合するまで成功を受理しない。起動失敗も消費済みとし、未確認lockを時間だけで奪わない。これはSDK内部のmodel request数の計測・課金上限ではない。

6.1 Sol xhighはwatchの許可済み候補へ追加し、従来simpleのallowlistは変えない。元`examples/takt/runtime.yaml`と工程別設定は変更していない。dev受入は提供v3の`live-isolated-runtime.yaml`をコピーし、SHA-256 `89140cbb8d83ca51a94ae3f2e471a219764a79531feb131514468b65a11fcefa`で束縛する。plan=6.1 Sol xhigh、coding/review=6 Sol medium、default/selector=Luna xhigh、assistant等はコピーの設定を維持する。

## dev専用入口

`scripts/watch-dev-acceptance.ts --live-authorized`は明示的な一件試験。通常runnerを有効にせず、実D1 API→lease→公式default→固定host検証→saveArtifact/finishArtifact→完了報告を使用する。合成Git、専用localhost認証、独立D1を新規作成する。既存IDの再実行は禁止。Git originは同一性契約のためだけに設定し、fetch/push/PR作成をしない。モデルの子ツールには通信・認証読取・Git操作権限を与えない。

起動には`WATCH_ACCEPTANCE_ID`、既存`CODEX_PACKAGE`、`CODEX_AUTH_FILE`を明示する。ローカルテスト認証を本番へ流用しない。モデル実行前に既存ログイン、公式schema、plan系列を確認する。成功判定には固定hostのnpm check/testと5個の独立assertionが必要。提供済み成功証跡だけで今回の成功とは扱わない。

## 環境制約と受入記録

最初の実モデル試験`99e0ba11-2d5c-43c0-9087-ece138956bb1`は、公式0.68.0が絶対cloneパスをセッション保存名へ展開するため`ENAMETOOLONG`で失敗した。CLI起動1回（6.1 Sol）、175398ms。タイムアウトやモデル予算超過とは区別する。watch PID namespace終了、process group消滅、D1 failed/hold_until=0を確認した。生のmodel応答は公開しない。

このため保存先長を開始前に検査する。clone名80byteとatomic保存suffix57byteを予約し、255byteを超える設定を拒否する。devのTAKT状態は短いWSL native `/tmp/paw-*`に置き、所在を専用devディレクトリに記録する。元設定や公式sourceは改変しない。

再試験は消費済み1起動と3分を差し引いた59 CLI・57分・各300秒に制限する。今回の終了状態と成果物は追記する。

## 検証・ロールバック

単体回帰はジョブ枠、複数CLIの重なり、総起動上限、全起動終了照合、6.1 allowlist、Luna plan拒否、保存先長、取消時hold維持を確認する。CIはsecret不要の型検査・単体・dry-run build・公式reader・実ローカルD1/Workflowsを実行する。live受入はCIから起動しない。

戻す場合はこのPRを配備しないか、通常watchガードを維持したまま変更commitをrevertする。未完了taskや未確認holdをSQLで強制解放せず、元runnerの停止証明を先に確認する。main merge・deploy・サービス有効化・外部成果物公開は別承認のままである。
