# 管理repo契約とローカル完了

開発taskは既知repo IDだけを指定する。管理者の`DEVELOPMENT_REGISTRY_FILE`はroot、worktree保存先、許可owner、visibility、公開可否を対応付ける。JSONは`examples/development-repositories.json`を参照する。HTTP/MCPからroot、argv、変更allowlist、公開権限を指定することはできない。

| repo ID | 固定base | 固定検証 |
| --- | --- | --- |
| private-agent | epic/development-runner | npm run check、npm run test |
| local-GPT-live | epic/transport-playback | node --check browser/playback-ack.mjs、node --test browser/tests/playback-ack.test.mjs |

local-GPT-liveの変更範囲は`browser/playback-ack.mjs`、`browser/tests/playback-ack.test.mjs`、`browser/README.md`、`.github/workflows/browser-ack.yml`、`docs/evidence/browser-playback-ack.md`の5ファイルのみ。branchは`feature/browser-playback-ack-client`に固定し、既存branchがある場合は上書きせず停止する。追加repoや検証コマンドの変更にはコードレビューが必要で、task本文は権限にならない。

worker起動前に管理者がrootとworktree保存先を作成する。symlink経由の配置は拒否する。実行前にowner、Git root／origin、GitHubの固定repo ID／visibility、隔離されたNode起動を確認し、実行不可ならモデル呼出し前に停止する。既存`DEVELOPMENT_REPOSITORY`設定はprivate-agentだけの互換設定で、ownerの既定値はlocal。別ownerには`DEVELOPMENT_OWNER`を明示する。registry使用時はrepoごとの公開可否が優先され、全体の公開フラグでは上書きできない。

TAKTには既存固定simple・model/effort・同時provider 1を使う。Git認証とcontrol-plane認証はmodelへ渡さず、検証は認証なし・外部networkなしのsandboxで固定argvを実行する。変更ファイルの数、量、実体パス、秘密らしい値を検証し、検証前後でsource hashを照合する。Python backend、LiveKit、GPU、実mic、Core履歴は今回のbrowser契約に含まれない。

`publishAuthorized:false`では、検証済みローカルcommitと`worktrees/.artifacts/<artifactId>.json`を保存し、`outcome:local_only`で正常終了する。結果にはrepo、owner、task、base/head SHA、source hash、検証契約、固定argv、TAKT検証情報を含む。公開許可がある新規taskだけがdraft PRを作り、`outcome:published`とprUrlを返す。

既存local-only taskを再実行して公開へ昇格させることはできない。prepare台帳はmodeも含めて固定し、成果物は内容hashによるIDで排他的に保存する。後日の公開APIは未実装である。将来追加する場合は別の承認operationとして、owner／repo／artifactId／exact head／検証証跡と現在のGit状態を再照合しなければならない。モデルの承認文や単なる設定変更で代用してはいけない。

## 初回候補の調査と検証範囲

2026-10-04にlocal-GPT-liveのepic base `01a680aa9825bcff0da7a1d8a83b9463cc231f1b`を確認した。PR2側の`2459c9b`から未push `502cc88043aeb67e40cb1bafac0cd852b11ff708`までの実差分はPython ACK失効テストと`docs/evidence/2026-10-04-ack-failure-regression.md`だけである。上記5ファイルとは重ならず、候補taskのbaseへ取り込まない。候補browser部品そのものはこの変更では実装・起票しない。

secret不要テストでは未知repo、任意argv／root、他owner、path traversal、symlink、改変成果物、既存taskの公開昇格を拒否する。純粋Node fixtureの固定検証では成功と故意の失敗の双方を実行する。fixture結果を実TAKT完了や実GitHub公開の証拠としない。

## 配備とrollback

この変更にDB migrationはない。control-planeとworkerを同じ版へ更新する。registry JSONは秘密値を含めず、worker token・Codex認証は既存の専用保管先で管理する。この変更自体はtoken発行、容量有効化、サービス起動、公開、実taskを行わない。

容量schemaの有限上限はSol5、Luna30、共有group35（Piとfixtureは従来どおり16）とする。実際の`LIMITS_JSON`は別途管理者が設定し、0による停止も維持する。profile数で枠を増やさず、全ownerで同じmodel keyを合算する。TAKTはSol/Lunaを各1と共有group1を予約し、内部providerは同時1のまま。API/GUIには現在のmodel枠と閲覧ownerの共有group上限を表示し、他groupの名前は返さない。既存DBの整数列・JSON予約にはmigration不要で、SQLiteの競合claim試験でLuna30、共有35、TAKT/Sol5を検証する。

戻す場合は新規受付を止め、workerの終了を確認して前版へ戻す。成果物・task台帳・worktreeは保持する。local-only成功を公開済みに変更したり、不確実な操作予約を消したりしない。前版はlocal-GPT-live契約とartifact operationを扱えないため、そのrepoの新規taskを起票しない。

Repository root and worktree storage must be canonical absolute paths that are disjoint: neither may contain the other. Sibling directories are supported, including names that share a prefix. Live acceptance scripts require an explicit `DEVELOPMENT_WORKTREES` pointing to an existing disjoint directory and validate it before submitting a task. Existing nested worktrees and evidence are preserved; administrators must choose a new location for future tasks.
