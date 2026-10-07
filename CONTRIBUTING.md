# 開発規約

main → epic/* → feature/*、fix/*、docs/*、infra/*、character/* の三層で開発する。作業PRはepicを向け、統合PRはmainを向ける。mainへのマージは利用者レビューと緑のCI、実際のCodeRabbitレビューの指摘対応を確認してから行う。設定ファイルの存在をレビュー完了とみなさない。

epic宛てPRの自動CodeRabbitレビューは意図的に対象外とし、CIで検証する。時間枠をmain宛てのレビューに集約するため、`base_branches`へepicを追加しない。再レビューは変更差分を対象とする `@coderabbitai review` を使い、担当者間で重複投稿しない。docstringの警告は公開境界の説明不足を確認する材料とし、数値を下げて隠さない。説明は実装の言い換えではなく責務・失敗・再実行条件を記す。

変更はConventional Commitsを使い、設計文書とコメントは原則日本語で記す。秘密、実会話、provider生応答をログやPRに載せない。Node 24の型検査・テスト・実行可能なローカルbuild、実SQLite/loopback HTTPの統合検証を省略しない。`npm run test:local`は新規隔離DBで6統合scriptを実行する。公式TAKT schema/config/bindingと`REQUIRE_PID_NAMESPACE=1`のwatch stubも必須で、namespace skipは成功に数えない。Cloudflare依存除去はmanifestとlock全体、稼働コード・設定の回帰で確認する。外部接続の未実施はfixture成功と区別する。過去のdocs/evidenceと試験件数・commit・失敗履歴を今回の結果へ書き換えない。

本番deploy、cron有効化、課金、認証権限変更、mainマージには個別の承認が必要。モデル出力は承認ではない。
