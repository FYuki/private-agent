# 開発規約

main → epic/* → feature/*、fix/*、docs/*、infra/*、character/* の三層で開発する。作業PRはepicを向け、統合PRはmainを向ける。mainへのマージは利用者レビューと緑のCI、実際のCodeRabbitレビューの指摘対応を確認してから行う。設定ファイルの存在をレビュー完了とみなさない。

変更はConventional Commitsを使い、設計文書とコメントは原則日本語で記す。秘密、実会話、provider生応答をログやPRに載せない。型検査・テスト・ビルドとCIのD1/Workflows検証を省略しない。外部接続の未実施はfixture成功と区別する。

本番deploy、cron有効化、課金、認証権限変更、mainマージには個別の承認が必要。モデル出力は承認ではない。
