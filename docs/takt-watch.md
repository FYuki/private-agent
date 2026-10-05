# TAKT watch 管理の初期slice

Agent基盤から固定版 TAKT 0.68.0（既存pin `6f4abf66c795f4c1a05ee0edb11cacaa0d1a475c`）のMCP／watchを管理する接続部。workflow・stage engine・reviewer・ループは公式TAKTを使い、PrivateAgent側で再実装しない。既存pipeline workerと本番serviceは変更していない。

## 実装・検証済み

- `WatchManager` は既存repository registryでowner/repo/rootを束縛する。callerがcwd・argv・公開権限をtask本文に含めても採用しない。
- Issue単位のrequirements／acceptance／validationを必須とし、workflow未指定は`default`、`worktree:true`、許可されたepicの`taskContext.baseBranch`を使う。実行可能workflow識別子は`default`／`simple`のみ。巨大Epicを単一taskへ変換する機能はない。
- 原本のQueueスキルを改変せず、専用の有効設定で`auto_pr:false`を明示。外部push/PRはPrivateAgentの別承認公開に一本化する。名前生成は`romaji`とし、enqueue時の隠れたAI要約を防ぐ。自動再投入回数は0。
- 0600のSQLite台帳へenqueue前予約。応答喪失後は80文字未満のASCII先頭markerで公式task一覧を照合し、同じenqueueを再送しない。task名・runSlug・指示書本文・workflowを照合し、別runへの置換や複数一致を拒否する。
- 依存先は先に登録された同一owner/repoのtaskだけ。`completed`は`collected`として回収し、host検証器が成果物証跡を確定するまで依存taskを投入しない。遅延した状態応答は比較更新で検証済み結果を巻き戻さない。生ログ/report本文は状態台帳・UIへ複製しない。
- watchのroot排他lockは管理DBが違っても共有する。PID、boot ID、開始tickを記録し、再接続時に実プロセスと照合する。不明な開始・stale lockを自動解除しない。明確に停止した履歴を保存したうえでのみ次のwatchを予約できる。
- SIGINTはdrain要求でありtask cancel完了ではない。process groupとPID namespaceの停止根拠がない場合は`stop_unconfirmed`を維持する。pending投入前のcancelは止められるが、投入後は`cancel_requested`として保持し、自動再投入・枠解放をしない。`tell_run`や失敗runの再実行を提供しない。

`scripts/watch-contract-check.ts` は専用合成rootで公式MCP enqueue/listと冪等性を確認する。そのrootではwatchを起動せず、別の空repoでwatch起動とSIGINT停止を試験する。UbuntuローカルではbwrapのPID/network namespace内で停止確認成功。bwrapがない検証環境では起動のみを確認し、子孫停止を保証済みとは報告しない。モデル呼出し・既存稼働ログ/DB読取・外部push/PRは行わない。

公式defaultの読み込み試験では、固定1名＋動的候補6観点のreview poolと最終APPROVE gateが存在することを確認した。これはモデルが全観点を選択・実行した証拠ではなく、全観点の必須化でもない。taskのconcurrency=1でも内部reviewer／selectorは複数のprovider呼出しを起こし得る。

## 本番切替前に必要な接続

現sliceの起動factoryは空queueの契約試験用で、認証情報・providerをmountしない。本番online表示、HTTP/MCPへの新しい公開受付、既存worker置換はまだ行わない。

1. watchの専用rootとTAKTのローカルcommit/root反映を、正本repoや既存task worktreeから隔離する。TAKTが作る複数commitの範囲を既存の変更allowlist・固定テスト・成果物hash検証へ接続する。現在の後日公開は単一commit契約なので、複数commitの成果物契約を別途検証する。
2. 内部selector・並列reviewer・phase2/3を含むactual provider call単位の有限モデル枠と共有quotaを接続する。既存の単一run予約をwatch task数と同一視しない。既存CLI wrapperの認証・時間・出力・子孫終了制限を弱めない。
3. watchへの引き渡しIDとD1 leaseを関連付ける。実行中cancelと全子孫の停止確認、結果回収後のhost validation、枠解放を接続する。watch SIGINTだけを取消完了にしない。
4. 旧workerの新規claimを停止し、既存runの完了/停止を照合してから、新しい専用rootで限定taskを実運転する。両方式が同じtask/rootを同時所有しない。mainへの未レビュー変更や自動service切替は行わない。

rollbackは新しい投入を止め、watchをdrainし、停止が確認できるまでlock/台帳を保存する。旧workerを同じ未完taskへ再投入しない。成果物と公開操作台帳は保持する。

## Queueスキルの出典

指定範囲の `/home/asa/.codex/skills`、`/home/asa/.claude/skills` と対象repo内を関連名で検索したが、旧TAKT Queueスキルの原文は見つからなかった。上記のIssue単位・AC/Validation・default・worktree・依存管理方針は親スレッドが確認した過去会話の要約に基づく。原文を読了したとは扱わない。個人AGENTS.md/CLAUDE.mdは読んでいない。

検証コマンド: `npm run check`、`npm test`、`npm run build`、固定runtime導入後の `node --import tsx scripts/watch-contract-check.ts`。既存D1/Workflows統合テストもCIで維持する。
