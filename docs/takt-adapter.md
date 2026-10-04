# TAKT実行アダプター

PrivateAgentが受付・owner認証・冪等性・容量予約・worktree・テスト・commit・push・draft PRを担当し、TAKTが計画・テスト作成・実装・レビュー・修正を担当する。TAKTのqueue/watchは使わない。既存のCodex直接実行profileとの暗黙fallbackはない。

## 固定版と設定原本

- TAKT `0.68.0`、公式tag commit `6f4abf66c795f4c1a05ee0edb11cacaa0d1a475c`。mainの同version表示とは区別する。
- `runtime/takt/package-lock.json`でnpm依存を固定。専用directoryで`npm ci --prefix runtime/takt --ignore-scripts`。グローバルTAKTやHOME設定は変更しない。
- `examples/takt/config.yaml`と`runtime.yaml`はユーザー添付の原本（Library version 0）をそのまま保存する。Library IDs: `libfile_b9c83a1870448191af32c76df3df812a`、`libfile_07a620d8dfc48191915d52d1b5a34a3c`。
- 実行ごとの`TAKT_CONFIG_DIR`へコピーし、ユーザー承認に従い`auto_pr:false`、`companion.enabled:false`を適用。原本は更新しない。
- 公式schemaとbuiltin loaderで検証し、requested/effective設定、展開workflow、builtin prompt bundleのSHA-256とresolved profilesをmanifestへ保存する。
- `--pipeline --skip-git --workflow simple --task <固定引数>`。0.68.0に存在しない`--runtime-file`等は使わない。

## 容量と認証

初期profile `takt-simple` は `programmatic` orchestratorと組み合わせる。計画はSol/xhigh、実装・レビューはSol/medium、内部selector等はLuna/xhigh。未使用のClaude/Pi profile定義は保存するが、選択された場合は未検証エラーにする。Pi extensionのインストールやAPIキーへの切替は行わない。

`LIMITS_JSON.models`には`codex-sol`と`codex-luna`を両方設定する。TAKT開始時に両モデル1枠ずつと同じChatGPT契約のgroup1枠を原子的に予約する。異なるmodel aliasを使って契約枠を増やさない。TAKT内部AgentとretryもCodex wrapperの排他lockを通り、同時provider processは1、呼出は最大120。TAKTの`concurrency:4`を内部上限の根拠にしない。

既存ChatGPTログインをreadonly mountし、モデルのツールから認証directory・`/proc`・実行lockへのアクセスを拒否する。Codex multi_agent/apps/skills/hooks/web検索を無効化し、ツールのnetworkを無効化する。モデルとreasoning effortは変更しない。TAKTやmodelにGitHub/control-plane tokenを渡さない。

## 起動

既存development workerの環境変数に以下を追加する。実パスを管理者が設定する。

```sh
TAKT_RUNTIME=/absolute/private-agent/runtime/takt
TAKT_INPUTS=/absolute/private-agent/examples/takt
TAKT_RUNS=/absolute/private-agent/.local/takt-runs
npm run worker:development
```

UIまたはMCPで`orchestratorProfileId:programmatic`、`executionProfileId:takt-simple`を指定する。`budgetMs`は既定4時間、1分から24時間までの有限値。既存answer jobの60秒は変更しない。CLI呼出のhard timeout20分・idle10分・全体期限を独立に適用し、lease heartbeatは継続する。上記時間は上限であり、長時間の実機動作を保証するものではない。

## 完了・中断

exit 0やmodel文中のAPPROVEだけでは公開しない。固定simpleのroot review承認、root superviseのAPPROVE rule、workflow_complete、meta/task一致を検証する。PrivateAgentはその後ソース制限、隔離テスト、テスト前後のcontent hash、publication ledgerを検証してdraft PRを作る。main mergeは禁止のまま。

project `.takt/config.yaml`・`runtime.yaml`は拒否し、実行中もreadonly maskする。継承環境変数はclearする。TAKTログやreportは専用run directoryに置き、modelからの書込やGit公開を許可しない。rawログにはtask/ソースを含み得るのでprivateローカル扱いとし、commit/外部送信しない。

cancelはprocess groupへSIGINTを送り、停止しない場合は強制終了し、close確認後にだけcompleteを報告する。停止不明のlockはTTLで解放しない。worker crashはfailed/interruptedとして自動再試行しない。保存されたTAKT内部状態は書き換えず、管理者が停止状態と公開ledgerを確認した後、新規taskを作る。任意地点からの無人resumeや内部承認GUIは未対応。

## 範囲とrollback

初回はbuiltin simpleの逐次実行のみ。defaultの多観点並列reviewは各内部実行の安全な容量上限を検証してから別途有効化する。Claude/Piの認証・課金、Cloudflare実アカウント、production secret/deploy/cron、main mergeはこの変更に含めない。

停止時はTAKT workerへSIGINTを送り、run/残存process/公開ledgerを確認する。TAKT新規受付を止め、既存Codex直接profileへ明示的に戻せる。D1 migration0004はnullable列追加のみで旧行を保持する。停止不明の容量予約をDBから無条件削除しない。
