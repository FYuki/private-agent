# adapter v3 取り込み（2026-10-05）

現在のジョブ枠・並列CLI・6.1 Sol契約とdev受入は [takt-watch-dev-acceptance.md](takt-watch-dev-acceptance.md) を参照。以下の未対応・直列化の記述は前slice時点の記録。通常runnerのガードは現在も維持する。

利用者の残作業再開指示に基づき、task-6の提供zipと成功証跡を照合した。原本とruntime.yaml、工程別モデル設定、他PoCの稼働状態は変更していない。既存PR22へ修正を保存し、mainマージ・本番配備・新規成果物公開は行わない。

## 取り込んだ修正

`official.mjs/readOfficialRunBinding` の方式を `development/watch-run-binding.mjs` へ移植。公式TaskRunnerとassertTaskStateWorktreeOwnershipでtask/run/cloneを確定し、元のqueued orderとrun-local snapshotの全文一致を確認する。meta/sessionには公式buildTaskInstructionの参照指示文を使う。単なる部分一致や最新runへの代替を行わない。

PrivateAgentではさらに、公式config cacheを専用subprocessへ隔離し、taskごとのworktree_dirを正しく解決する。元order/run orderは通常file・size・hardlink数・canonical pathを検査し、symlink、本文変更、別task/run/workflowを拒否する。新しい任意コマンドAPIは作らない。

## 証拠と境界

zip SHA-256と76ファイルのmanifestを照合。提供された公式default成功runについて、8 reportのSHA-256を再計算し、同runの追加model call 0による再検証、独立AC4/4、生成テスト6/6、27 CLIの子孫0・枠解放を確認した。提供adapterの30契約テストも参照コピー上で再実行して成功。要約は `docs/evidence/takt-adapter-v3.json`。raw providerログをリポジトリへ移していない。

`scripts/watch-binding-check.ts` は公式readerを使う合成fixture試験である。外部live成功をPrivateAgent全体の実動作成功と混同しない。新しい実モデル呼出しは行っていない。

## 残る具体的操作・判断

- PrivateAgentの通常runner→D1 lease→公式default→固定host検証→artifact保存の一続きの成功試験は別途必要。稼働入口の `watch_runtime_validation_pending` は維持する。
- 提供PoCはplanモデル系列ごとにjob1枠、公式parallel reviewを維持（観測CLI同時2）。現PR22はSol/Luna各1枠予約・外側CLI直列化。共有枠の単位を揃えるにはD1契約の別レビューが必要で、一括置換していない。外側CLI回数をSDK内部model request回数とは扱わない。
- 提供PoCのplanはgpt-6.1-sol xhigh、coding/reviewはgpt-6-sol medium、default/selectorはLuna。現PR22の許可モデルとの違いを解消する際も、原本runtimeを上書きしたり工程設定を暗黙変更したりしない。未対応modelは明確に拒否する。
- PR20のCodeRabbit差分レビューは利用者指示により1回再依頼。結果を確認して必要指摘だけ対応する。mainマージ、本番watch起動、D1/deploy、Git成果物の外部公開には具体的対象の承認が必要。
