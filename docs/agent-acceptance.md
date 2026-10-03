# 汎用基盤の検証記録

2026-10-02。V1のmainマージは別作業により行われており、この変更はそのmainを基点としたepic/agent-runtime → feature/generic-agent-loopで実装した。本作業でmainマージは行わない。

合成Gateway/Toolと実SQLiteで人格切替、tool結果を含む複数ターン、write意味的重複排除、read再取得、schema/allowlist、不明副作用、期限、取消、再起動時の保留を検証する。Core SDK転送は一時localhost HTTPでwire形式、redirect拒否、応答上限を検証する。実Coreや実モデルでの汎用tool loop成功は未確認。

独立レビューでredirect、同期処理によるdeadline超過、finalのtranscript上限、readキャッシュの4点を指摘され、実装修正と回帰ケース追加を行った。既存V1の24テストも維持する。CIは全PRとmain/epic pushに実行し、型検査・全テスト・dry-run build・ローカルD1 migration・Workflows・有限60秒スケジュールを検証する。

CodeRabbit設定追加と実botレビューの完了は区別する。実レビュー状況はPRのチェック・コメントを確認する。CodeRabbitのインストール、権限、契約、GitHub保護設定をこの作業では変更しない。

追加検証: 親レビューのSQLite予約遅延後deadlineと数値tool call IDの指摘を修正。同期reserve遅延による期限超過でwriteが起動しないこと、異常ID/nameで副作用ゼロを検証する。HTTP複数ターンのcall ID・toolエラー往復、同時run、write中cancel/遅延結果も回帰ケースに含む。

合成汎用ジョブの定期実行とUIの予定/結果表示を既存経路へ接続した。実時間試験はCLI fixture 2runとgeneric fixture 2runを検証する。Coreサービス接続や実LLM推論とは区別する。

2026-10-02 18:04:43 UTC、隔離ローカルD1で実時間試験成功。60,006ms間隔、CLI 2runとgeneric 2run、合計4run成功、generic結果は `alice: 5`。以前の試験DBはjob上限に達していたため既存状態や上限を変えず、`.local/agent-integration` にmigrationして検証した。

PR #1の監査: GitHub API上のmerged_byはFYuki、merged_atは2026-10-02T17:31:30Z、merge commitは5408928a936e9620df07d7f3dea2e80b4e2a82e6。この変更の開発基底として保全している。

Core実サービス結合: 2026-10-02 18:12:24 UTC、Core側localhost:18080の実APIとprivate-agentの公式SDKアダプターを接続。character_id=miori、fixture_pingの呼出しと合成結果の再送を経て、2turn/1tool call/1executionでcompleted。Core内部providerはfixtureであり、実LLMではない。tool call応答のcontent省略をnullへ正規化する互換修正も回帰検証した。

18:13:41 UTCにはcharacter_id=otherでも同じ2turn/1tool call/1executionでcompletedを確認。スマホ幅390pxの実Chromiumで予定のcharacter IDと保存結果、横はみ出しなし、JSエラーなし、logout消去を確認。日本語はrepo内fontconfigから既存Windowsフォントを参照して目視確認した。global font設定は変更していない。

未実施: production認証、SSE、Core実モデルの定期実行、実副作用tool、未知結果の手動照合UI。本番cron、deploy、課金は無効のまま。
