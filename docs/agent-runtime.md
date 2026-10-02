# 汎用エージェント基盤

`agent/loop.ts` はWSL/Node 24向けのライブラリ。合成専用の `agent-fixture` ジョブを既存のスケジューラーとpollerに接続している。Core実接続の定期ジョブと実ツールの権限・書込能力は追加していない。ModelGateway/ToolExecutor/RunStoreは `agent/contracts.ts` に分離する。

`runAgent(task, { gateway, tools, store }, signal)` へ管理側がowner、runId、characterId、goal、allowedToolsを渡す。CoreGatewayのbaseURLは明示した `http://127.0.0.1:<port>/v1` またはIPv6 loopbackのみ。`POST /character/completions` へcharacter_id、text messages、function tools、tool_choice:auto、stream:false、max_tokens:1024を送る。物理model、endpoint、API keyをモデルやtaskから指定できない。SDKの環境APIキーと自動再試行は使用しない。ローカル接続用の非秘密placeholder Authorizationのみであり、本番認証として使用してはならない。

通常応答とfunction tool callsはChatCompletions形式。tool結果はrole:toolとtool_call_idで次回へ渡す。AbortSignalでHTTPを中断する。初期実装ではSSE、alias入口、Core認証、リモート接続は未対応。Coreエラーの生本文はrun結果へ保存せず、gateway_or_store_failedとして扱う。必要な次の契約は信頼できる物理モデル/認証グループ情報、認証、エラー分類、SSE失敗イベントである。

既定上限は4ターン、6 tool calls、同一tool 3回、30秒、会話64KiB。利用者設定は減らすことだけ可能。モデル応答16KiB、引数8KiB、tool結果16KiB。allowlist外と不正引数はtoolへ渡さずエラーをモデルに返す。read失敗は正規化して返し、write失敗は結果不明として停止する。書込の同じ意味の再試行はキャッシュする。readは同じcall IDだけをキャッシュし、新しいcall IDで再読取する。

SQLiteファイルは管理側が指定した信頼済みローカルパスに置き、ファイル権限0600。task/modelからパスを受け付けない。DBにはgoalのハッシュ、実行状態、tool結果が残るためローカル機密データとして管理する。Coreの記憶ストアやD1 leaseとは別物である。未完runは再起動後busyとなり自動再取得しない。手動照合手段は今後実装する。既存V1のlease再取得は引き続き独立して機能する。

AbortSignalを無視するtoolをJavaScriptのPromiseだけで物理停止できない。ツール実装は協調停止または既存の独立プロセスdeadline guardが必須。停止後の結果は採用せず予約を不明のまま残す。並列実行は同一runについてSQLite予約で防ぎ、グローバル容量制御は既存V1側の責務である。

検証: `npm run check && npm test && npm run build`。agent.test.tsは合成データと実SQLiteを使う。Coreサービス・実LLMとの接続成功はこれらのテストから主張しない。ロールバックは該当PRをrevertし、新ライブラリの呼出しを停止する。既存D1 schemaの変更はない。

## 有限定期ジョブへの接続

local MODEでのみ `provider: "agent-fixture"` と `agent: {"characterId":"alice","toolset":"fixture-v1"}` をジョブに指定できる。characterIdはalice/bobの合成2種、toolsetは固定の加算toolだけ。任意コマンド・パス・endpoint・物理モデルは受け付けない。既存のAPI認証、owner、lease、heartbeat、cancel、再試行上限、日次上限を共用する。production MODEはこのproviderの作成・取得を拒否する。

`LIMITS_JSON.models.agent-fixture` が省略または0なら取得停止。これは費用ゼロの合成用枠であり、Coreの実モデル容量を表すものではない。認証グループ枠も共用する。旧pollerの無指定claimには合成ジョブを返さず、`WORKER_PROVIDER=agent-fixture` を明示したpollerだけが取得する。`AGENT_STATE_DB` には管理者指定の絶対パスを設定する。DBは再起動時も保持する。同一D1 run IDの再試行は同じagent台帳を使い、完了済みなら保存結果を再報告、不明なら停止する。

例: `WORKER_PROVIDER=agent-fixture AGENT_STATE_DB="$PWD/.local/agent.db" npm run worker`。CONTROL_URL/WORKER_TOKENは既存のローカル設定を使う。モデルやジョブから環境変数を変更できない。UIの既存予定カードにはcharacter IDが表示され、結果は既存runカードへ保存・表示する。ジョブ作成UIは追加していない。

`scripts/realtime-check.ts` は実時間60秒間隔の2回についてCLI fixtureとgeneric fixtureを別の実pollerで実行する。timer→Workflows→D1 claim→generic loop→tool→D1結果の経路を検証する。cronは有効化しない。CIには秘密やCoreサービスは不要。

## Core結合確認

Coreサービスの準備後、`CORE_URL=http://127.0.0.1:<port>/v1 CORE_CHARACTER=<登録ID> node --import tsx scripts/core-join-check.ts` を明示実行する。Coreのtests.fixture_serverに対し、固定の合成goalとゼロ引数fixture_ping read toolだけを使用する。実tool callと最終応答を要求し、状態・回数だけを `.local/evidence/core-join-<character>.json` に記録する。上流がfixtureか実モデルかは実施時に別途記録し、このスクリプトの成功だけで実LLM動作を主張しない。CIからの自動呼出しはない。
