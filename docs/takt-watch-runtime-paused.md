# watch runtime 開発停止点と再開状況（2026-10-05）

2026-10-08 UTC追記：[Issue29の実接続](evidence/watch-review-issue29.md)で、必須レビューを含むwatchから成果物・Epic宛draft PRまで成功した。通常profileへの運用切替は未実施。以下の過去試験記録は保持する。


2026-10-07：本人が[実行寿命の分離](takt-watch-lifetime.md)の修正・確認をmain向けPRまで進めることを指示。下記の「main/epicへこのスライスをマージしない」は過去の停止点であり、このPR準備を禁止する現在の指示ではない。本番有効化とmain mergeは行わない。

現在のジョブ枠・並列CLI・6.1 Sol契約とdev受入は [takt-watch-dev-acceptance.md](takt-watch-dev-acceptance.md) を参照。以下の未対応・直列化の記述は前slice時点の記録。通常runnerのガードは現在も維持する。

再開指示によりadapter v3の公式run bindingを移植済み。下記P1のtask照合不一致は修正し、合成公式readerで検証した。現在の証拠と残事項は [取り込み記録](takt-watch-adapter-integration.md) を参照。通常runnerの実稼働入口は、全体成功試験と設定契約の確認まで閉じている。

以下は停止時点の記録。

利用者のフレームワーク選定を待つため、epic/takt-watch の次スライスを feature/takt-watch-runtime の draft PR に隔離して停止する。main/epicへこのスライスをマージせず、deploy・既存worker/service切替・本番watch有効化をしない。選定PoCとは独立した作業である。

## 稼働入口

`TAKT_WATCH_ENABLED=true`、`developmentOnce` の watchEnabled、直接開発実行の takt-watch profile は `watch_runtime_validation_pending` で拒否する。通常runnerはclaimより前に拒否する。既存takt-simpleの既定値は維持。API/D1には次スライスの契約があるが、このブランチのwatch taskを実稼働へ投入しない。既存serviceは停止していない。

## 実装・検証済みの部品

- D1: opt-in profile、同owner/repoの既存依存のみ、成功・artifact完了・hold解放までclaim待機。Sol1/Luna1/group1を原子的に予約し、cancel/期限切れでも停止ACKまで保持。
- 公式TAKT 0.68.0: default/simple設定解決、autoPr:false、worktree:true、romaji、concurrency1、自動再queue0。未使用provider定義は保持し、選択候補は公式resolverで確認。独自stage engineは作らない。
- 物理provider: 全呼出しを共通lockへ直列化し、合計最大120、1呼出20分、無出力10分、出力4MiB、待機20分。task数をprovider呼出数の代用にしない。selector/各reviewer/phaseの実呼出しもゲートを通る。
- 各leaseのwatchをPID namespaceへ隔離。SDKの--cdをrunning task/clone ownershipへ照合し、modelからGit metadata・watch制御・他taskを隠す。取消はdrainと区別してnamespaceを終了し、不明時はD1完了報告を送らない。
- 複数commit成果物: 線形120commit以内、変更20path以内、累積blob1MiB以内、全中間commitのpath/type/secret形式を確認。最終treeの既存固定検証も維持。承認manifestにrange proofを含め、公開直前に再検証。旧single-commit artifactは引き続き親commit一致を要求。
- defaultの最終APPROVEと親workflowへのCOMPLETE伝播をcanonical stack/ref/callInstanceで検証。TAKTの完了やmodel本文だけでは公開を承認しない。依存完了は自動mergeや基点への変更取り込みを意味しない。

## 未完了・残リスク（入口を開かない理由）

**P1: 正常成功のtask照合が公式TAKTと不一致（解決済み: [取り込み記録](takt-watch-adapter-integration.md)）。** enqueueはorder.mdを保存し、実行時に公式buildTaskInstructionがcontext/task参照の指示文へ変換する。adapterは元orderTextをmeta/session taskと比較するため、正常成功でも拒否する。元order.mdの内容と所有権を別途確認し、公式生成指示文をexpected taskとして照合する修正が必要。

正常成功→review承認→複数commit import→固定host tests→artifact保存の一続きの公式watch試験は未実施。実Codex/ChatGPTログインによるwatch試験、スマホ画面からのwatch投入、稼働service切替も未実施。失敗stubの成功を実モデル成功と扱わない。defaultの動的reviewer候補をすべて実行済みとは扱わない。

## 再現可能な証拠

`npm run check && npm test && npm run build`。`scripts/watch-runtime-config-check.ts` は公式default/simpleをモデルなしで解決。`scripts/watch-runtime-smoke.ts` は新規temp repo・偽認証fixture・明示失敗stubを使い、公式watch→SDK→内側sandboxへの到達、失敗収集、停止と元HEAD保全を検証。PID namespace非対応環境では未実施を明示し、WSLでは実実行を確認。

`tests/watch.test.ts` はsetsidしたSIGINT耐性子孫の強制停止を実プロセスで確認。`tests/takt.test.ts` は呼出直列化・上限・待機中取消を確認。実Gitで中間禁止path/secret/merge履歴拒否と複数commit公開前検証を確認。`scripts/watch-api-check.ts` はlocal D1のprofile・owner・依存待ち・取消を検証する。CIは既存D1/Workflows migrationと統合回帰も実行する。

## 再開・rollback

1. フレームワーク選定結果と利用者の再開指示を確認する。別PoCや旧workerを勝手に起動停止しない。
2. draft PRの固定head・CI・このP1を確認し、公式成功fixtureを追加してtask照合を修正する。
3. 成功からartifactまで、cancel/lease喪失/子孫停止不明、複数commit公開再照合の契約を検証する。main向け実レビューと利用者レビューを得るまでmainへ入れない。
4. 実モデル試験とservice切替は別途調整する。通常APIキーや従量課金へ切り替えない。検証を終えるまでvalidation_pendingを解除しない。

このdraftを採用しない場合はPRを閉じればよい。共有main/epicや稼働環境へのrollbackは不要。合成試験のtempデータとworktreeのignored `.local/.wrangler/.dev.vars` は本番資料・本番鍵として使わない。
