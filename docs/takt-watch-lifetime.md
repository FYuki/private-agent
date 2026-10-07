# TAKT実行とPrivateAgent監視の寿命

TAKTへ登録した実装は、PrivateAgentの監視切断・MCP通信timeout・D1 heartbeat切れでは止めない。TAKTの工程、レビュー、反復は公式workflowへ委譲する。6時間以上の実装でも同じtask/runを監視・回収する。

## 実行所有者と再接続

`executeWatch` は `<task UUID>.execution/request.json` を排他的に予約し、監視processとは別sessionの `watch-execution-worker.ts` を一度だけ起動する。実行所有者が公式watchのPID namespace、MCP接続、停止・成果物検証を所有する。observerのAbortSignalと期限はこのprocessへ渡さない。

予約にはowner、order、base SHA、worktree、runtime設定と保存先を保存する。再接続は完全一致した予約と同じtaskを使い、新しいenqueue・worker・providerを開始しない。enqueue/起動の結果が不明なときは自動再送しない。終端は `result.json` へatomicに保存し、別processから回収できる。

実行所有者内のMCP list要求が切れた場合はMCPだけ再接続する。新しいtaskを作ったり、watchを停止したりしない。MCPの1要求30秒と、Git/config検証コマンドの1要求60秒は通信・補助処理の期限であり、TAKT実装全体の期限ではない。watch出力は蓄積せず排出し、累積ログ量でwatchを停止しない。

## D1と取消

D1の `takt` 操作予約以降を引渡し境界とする。そこからはlease/deadline切れだけでfailedにせず、占有枠を保持する。同じowner/worker/groupによるclaimは元のrun/token/attemptを返す。別workerによる引継ぎや実行所有者の自動再起動は行わない。引渡し前、takt-simple、通常の定期jobの既存lease契約は維持する。

明示取消はD1 heartbeatの `cancelRequested` またはhost管理操作から実行所有者の取消ファイルへ伝える。実行所有者がnamespaceを停止して終端を保存した後にだけ停止ACK・枠解放する。HTTP通信失敗は取消として扱わない。実行所有者のクラッシュ、ホスト再起動、停止証明欠落は `watch_execution_unconfirmed` 等で保留し、自動再投入も枠解放もしない。

## 上限

通常watchには従前の最大60 CLI／1 CLI 300秒／無出力300秒を適用しない。TAKT workflowの制御はそのまま使う。`maxProviderCalls`、`watchLimits.callMs`、`watchLimits.wallMs` はhost管理者が有限試験などで明示した場合のみ適用する。試験の `wallMs` は起動時に固定し、observer再接続で延長しない。通常入口の旧 `budgetMs` は引渡し前・監視セッションの値で、TAKT実行寿命にはならない。

CLI出力4MiB、成果物の型・パス・サイズ・秘密形式検査は既存の入出力契約として維持する。これらは実行時間や課金上限ではない。実モデル試験の予算承認と、通常運用の設定は別に扱う。

## host管理操作

以下は既存実行への接続だけを行い、新規taskを開始しない。

```bash
# 1分間だけ完了を待つ。時間切れでも実行は続き、同じ操作で再接続できる。
node --import tsx scripts/watch-execution-control.ts /absolute/runs/<UUID>.execution wait
# 指示は標準入力から読む。同じkeyは二重送信せず、応答不明は未確定として保持。
node --import tsx scripts/watch-execution-control.ts /absolute/runs/<UUID>.execution tell instruction-1 < instruction.txt
# 明示取消。戻り値は取消要求の記録であり、停止完了ではない。
node --import tsx scripts/watch-execution-control.ts /absolute/runs/<UUID>.execution cancel
```

追加指示はowner/order marker/workflowとrunning runを照合して `takt_tell_run` へ送る。配送受付を消費・workflow成功・公開許可とみなさない。公開HTTP/UIの追加指示APIは今回追加していない。

## 検証範囲

- UT/IT1：監視期限・切断が取消ファイルを作らないこと、永続結果の再読取、61番目のCLIを旧上限で拒否しないこと、明示試験枠の維持。
- D1：時計を6時間進め、heartbeat無しでも同じrun/token/attemptを回収、他workerの取得拒否、取消後の停止ACKまで枠保持。
- 公式TAKT＋stub：最初のobserver processを終了、MCP processを強制終了、watch継続とMCP再接続、追加指示、再投入なしの失敗回収、別taskの明示取消とnamespace停止。
- 寿命分離修正時点（`5b2510c`）：型検査、129テスト、dry-run build、公式schema/config/reader、実ローカルD1/Workflowsとrealtime fixture。

6時間の実時間・実モデル運転や、公式default成功→host→artifactのlive完走を実施済みとは扱わない。通常runnerの `watch_runtime_validation_pending`、本番cron無効、公開承認境界は維持する。今回のmain向けPRは寿命分離の修正であり、本番有効化やmain mergeは別操作。

## PR20レビュー修正の検証（2026-10-07）

取消済みrunの再claimはoperation開始前に実行所有者へ取消を配送し、永続終端の確認後だけD1へ停止ACKを返す。停止未確認の終端ではholdを維持する。完了を観測した時点のrunSlugを使い、完了後のMCP再要求やMCP close失敗をnamespace停止未確認と混同しない。process identity照合前後の結果保存競合も回帰試験に含めた。

通常profileは `available:false` / `watch_runtime_validation_pending` を返す。dev受入だけがlocalhost設定の `WATCH_ACCEPTANCE_ENABLED=true` と内部 `allowWatchTest` を明示する。公開payloadからこのフラグを指定することはできず、通常runnerのガードは維持する。

135テスト、型検査、dry-run build、公式schema/config/binding、全ローカルD1/Workflows統合、公式TAKTの切断・再接続・追加指示・明示取消stubを確認した。CIはSol枠を明示してwatch lease取得を必須化し、PID namespace非対応時を成功扱いしない。CIではUbuntu 22.04にbubblewrapと隔離環境内のNode 24を明示導入する。CI自体の結果は各PR headのcheckを参照する。

準備証跡JSONの124件、寿命分離時点の129件は各時点の履歴として保持する。これらのstub成功・時計を進めたD1試験は、実モデルの統合完走や6時間耐久の証明ではない。
