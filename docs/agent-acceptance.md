# 汎用基盤の検証記録

2026-10-02。V1のmainマージは別作業により行われており、この変更はそのmainを基点としたepic/agent-runtime → feature/generic-agent-loopで実装した。本作業でmainマージは行わない。

合成Gateway/Toolと実SQLiteで人格切替、tool結果を含む複数ターン、write意味的重複排除、read再取得、schema/allowlist、不明副作用、期限、取消、再起動時の保留を検証する。Core SDK転送は一時localhost HTTPでwire形式、redirect拒否、応答上限を検証する。実Coreや実モデルでの汎用tool loop成功は未確認。

独立レビューでredirect、同期処理によるdeadline超過、finalのtranscript上限、readキャッシュの4点を指摘され、実装修正と回帰ケース追加を行った。既存V1の24テストも維持する。CIは全PRとmain/epic pushに実行し、型検査・全テスト・dry-run build・ローカルD1 migration・Workflows・有限60秒スケジュールを検証する。

CodeRabbit設定追加と実botレビューの完了は区別する。実レビュー状況はPRのチェック・コメントを確認する。CodeRabbitのインストール、権限、契約、GitHub保護設定をこの作業では変更しない。

未実施: Coreとの実接続、production認証、SSE、汎用ジョブのWeb画面/定期実行接続、実副作用tool、未知結果の手動照合UI。本番cron、deploy、課金は無効のまま。
