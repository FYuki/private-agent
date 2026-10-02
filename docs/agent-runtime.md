# 汎用エージェント基盤

`agent/loop.ts` はWSL/Node 24向けのライブラリ。既存の読み取り要約ジョブと公開HTTP APIにはまだ接続していない。実ツールの権限や書込能力は追加していない。ModelGateway/ToolExecutor/RunStoreは `agent/contracts.ts` に分離する。

`runAgent(task, { gateway, tools, store }, signal)` へ管理側がowner、runId、characterId、goal、allowedToolsを渡す。CoreGatewayのbaseURLは明示した `http://127.0.0.1:<port>/v1` またはIPv6 loopbackのみ。`POST /character/completions` へcharacter_id、text messages、function tools、tool_choice:auto、stream:false、max_tokens:1024を送る。物理model、endpoint、API keyをモデルやtaskから指定できない。SDKの環境APIキーと自動再試行は使用しない。ローカル接続用の非秘密placeholder Authorizationのみであり、本番認証として使用してはならない。

通常応答とfunction tool callsはChatCompletions形式。tool結果はrole:toolとtool_call_idで次回へ渡す。AbortSignalでHTTPを中断する。初期実装ではSSE、alias入口、Core認証、リモート接続は未対応。Coreエラーの生本文はrun結果へ保存せず、gateway_or_store_failedとして扱う。必要な次の契約は信頼できる物理モデル/認証グループ情報、認証、エラー分類、SSE失敗イベントである。

既定上限は4ターン、6 tool calls、同一tool 3回、30秒、会話64KiB。利用者設定は減らすことだけ可能。モデル応答16KiB、引数8KiB、tool結果16KiB。allowlist外と不正引数はtoolへ渡さずエラーをモデルに返す。read失敗は正規化して返し、write失敗は結果不明として停止する。書込の同じ意味の再試行はキャッシュする。readは同じcall IDだけをキャッシュし、新しいcall IDで再読取する。

SQLiteファイルは管理側が指定した信頼済みローカルパスに置き、ファイル権限0600。task/modelからパスを受け付けない。DBにはgoalのハッシュ、実行状態、tool結果が残るためローカル機密データとして管理する。Coreの記憶ストアやD1 leaseとは別物である。未完runは再起動後busyとなり自動再取得しない。手動照合手段は今後実装する。既存V1のlease再取得は引き続き独立して機能する。

AbortSignalを無視するtoolをJavaScriptのPromiseだけで物理停止できない。ツール実装は協調停止または既存の独立プロセスdeadline guardが必須。停止後の結果は採用せず予約を不明のまま残す。並列実行は同一runについてSQLite予約で防ぎ、グローバル容量制御は既存V1側の責務である。

検証: `npm run check && npm test && npm run build`。agent.test.tsは合成データと実SQLiteを使う。Coreサービス・実LLMとの接続成功はこれらのテストから主張しない。ロールバックは該当PRをrevertし、新ライブラリの呼出しを停止する。既存D1 schemaの変更はない。
