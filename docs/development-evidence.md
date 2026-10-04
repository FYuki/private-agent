# 開発runner 受入記録（2026-10-04）

Ubuntu専用worktree、Codex CLI 0.159.0 / ChatGPT既存ログイン / gpt-6-luna を使用。API課金fallbackなし。

| 検証 | 観測 |
|---|---|
| ローカル型検査・既存/新規unit | 成功（最終件数はPRのCI参照） |
| D1 migration 0001–0003 | `--local` 全適用成功 |
| Workflows | 2回の模擬スケジュール、重複通知を含む4run成功。実LLMなしのfixture |
| 開発API | 認証拒否、同キー重複、入力競合、cancel、900000ms予算を実D1確認 |
| MCP | SDKの実stdio transportで4tools→owner APIの契約確認。dot接続自体は未実施 |
| 隔離 | 合成authの直接/proc読取拒否、外部書込・symlink・子ツールnetwork拒否、GitHub/control資格情報非公開 |
| モデル | 強化後permissionsで小さな合成ファイル編集成功 |
| GUI | 既存Chromium、390×844、モデル選択・送信・cancel・logout消去成功 |
| 実タスク | plan/edit/test/commit/push/pull-requestすべて操作台帳でcompleted、draft PR #5作成 |

実タスクは小さな状態ラベル関数とテストのみ。base `66d85f5684572efec83c35782d9fdcb5871c996c`、head `1276a6250171e48b6b036c8b5ff863cef45aa4c5`、[draft PR #5](https://github.com/FYuki/private-agent/pull/5)、[同headのCI成功](https://github.com/FYuki/private-agent/actions/runs/37195674141)。モデル編集をモックした結果ではない。

最初の実タスクはread-only計画コンテナの依存mount先が未作成のため `operation_blocked` で停止した。自動再実行・外部書込は発生しなかった。mount先をsupervisorが事前作成するよう修正し、新しいタスクで上記成功を確認した。

独立レビューで発見した認証読取境界、cancelと予約の競合、並行完了上書き、テスト中のソース改変を修正。テスト前後に内容/mode/削除状態を照合する。CodeRabbitの成功statusだけでは実レビュー完了と判断しない。契約状況とbot本文を別途確認する。

本番deploy・cron・dot ingress/auth・Claude・TAKT由来レビューの実装はこの受入記録に含まない。main未merge。既存停止サービス・他repo・private-knowledgeは変更していない。
