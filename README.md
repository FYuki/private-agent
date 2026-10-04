# private-agent

GUI / dot MCP から単発の開発タスクを受け付ける経路は [開発runner](docs/development-runner.md) を参照。司令塔と実行モデルを別profileで選択し、専用worktree・隔離テスト・同一private repoへのdraft PRまで接続する。mainへのマージは行わない。

汎用エージェント基盤は [agent-runtime](docs/agent-runtime.md) を参照。ローカル限定の合成ジョブは有限スケジュール、実poller、検証済みtool loop、D1結果保存まで接続済み。Core実サービスのfixture providerとは実HTTPで結合確認済み。実LLMとCore実モデルの定期接続は未実施。従来のCLIジョブはそのまま利用できる。

定期タスクで **GPT-6 Luna / Devin SWE-2** を呼び、状態と結果を記録する最小MVPです。Cloudflare Workers + Workflows + D1が予定・台帳を持ち、Ubuntu WSLの同じworkerを設定違いで複製できます。初期受け入れは知識要約専用ではなく、有限の定期実行です。

**本番未デプロイ・cron無効・mainへのマージはユーザーレビュー待ち。** スマホ向け画面は閲覧とcancelのみ。ローカルはlocalhost限定です。

## 接続は既存CLIに任せる

| Profile | 接続コンポーネント（実証版） | 固定モデル | 認証 |
|---|---|---|---|
| `codex-luna` | 公式Codex CLI 0.159.0 | `gpt-6-luna` / low | 既存ChatGPTログインを強制 |
| `pi-swe2` | Pi CLI 0.87.1 + 既存 `pi-devin-connector` 0.1.2 | `devin/swe-2-medium` | 既存PiのDevin認証 |

既存CLI経路のOAuth、provider固有HTTP/SSE、モデルカタログはCLIへ委譲します。別モジュールにはCore向け非ストリーミングHTTPアダプターと上限付きtool loopを実装済みで、Coreのfixture providerとの結合を確認しています。Core実LLMによる定期実行は未検証です。CLIは既存インストールを使用し、自動インストール・更新もしません。Piコネクターは第三者製で、Devinの公式SDKではありません。既に導入済みだったものを使用しました。Devin公式CLI 3000.11.3の認証・SWE-2利用可能一覧も確認しましたが、今回の実行経路はPiです。新しい接続先や課金APIへfallbackしません。

LangGraphは未導入です。必要になればWSL内の`Runner`（`provider, prompt, AbortSignal -> result`）を置換できます。Workflowsの責務は予定の受付とD1への投入1ステップのみで、思考グラフを二重管理しません。Coreは任意の交換可能なModelGatewayで、既存CLIジョブの必須依存ではありません。定期queueのCore実モデルproviderはまだ許可していません。

## ローカル起動（Node 24 / Ubuntu）

```bash
npm ci
npm run dev:setup        # .dev.vars と .local/tokens.json を0600で作成。既存を上書きしない
npm run db:local         # --localのみ
npm run dev             # 127.0.0.1:8787
```

別の端末でsecret不要の統合試験:

```bash
npm run check
npm test
npm run test:integration
npm run build           # wrangler deploy --dry-run。本番deployではない
```

画面は `http://127.0.0.1:8787/`。`.local/tokens.json`の`viewer`を入力します。トークンはブラウザーのメモリだけに保持し、URLやlocalStorageに保存しません。ログアウトで画面の結果を消去します。ローカル開発サーバーをLAN/トンネルに公開しないでください。

実workerは既存CLIへの絶対パスを環境変数で指定します（`.env.example`）。CLIの既存認証をそのまま利用し、認証ファイルをコピーしません。

```bash
export CODEX_BIN=/absolute/path/to/codex
export PI_BIN=/absolute/path/to/pi
export PI_DEVIN_EXTENSION=/absolute/path/to/pi-devin-connector/extensions/index.ts
export WORKER_TOKEN="$(node -p 'JSON.parse(require("fs").readFileSync(".local/tokens.json")).worker')"
export WORKER_PROVIDER=codex-luna  # 省略時は両方。別profileではpi-swe2
npm run worker -- --once         # 1件だけ取得。--once省略はserial poll
```

実モデルを各2回だけ使う有限試験（合成データのみ、サブスク枠を消費）:

```bash
npm run test:integration -- --live
```

2回の予定時刻をローカルtick APIへ送り、各通知を意図的に重複させます。D1受付→Workflows→WSL実CLI→結果保存を検証します。試験後は作成した予定を停止します。継続cronは作りません。1ownerのジョブは保守的に合計10件までなので、何度も試験する場合は別の隔離ローカルDBを用意してください。

## 設定とAPI

`POST /api/jobs`に`examples/schedule.disabled.json`の形を渡し、`Idempotency-Key`ヘッダーを付けます。同じkey/同じ入力は同じjob、異なる入力は409。CLI用`provider`は`codex-luna`と`pi-swe2`です。local MODEでは合成専用`agent-fixture`も指定でき、`agent: {"characterId":"alice","toolset":"fixture-v1"}`が必須です（characterIdはalice/bobのみ）。productionではfixture作成・取得を拒否します。任意コマンド・パス・URLは受け付けません。`startAt`はUTC epoch ms、間隔60〜86400秒、最大1〜10回。予定作成とcronの有効化は別です。予定変更は旧jobをdisableし、新keyで作成します。

`overlapPolicy`は`skip`のみ（省略時もskip）。同じjobのstarting/queued/runningまたは停止未確認の予約枠があれば、今回をskippedとして新しいWorkflowを作りません。別jobは別lockで、model/account上限は別途共有します。過去の未受付回はcatchupせず、スキップ記録も有限スケジュール内の最大10件です。常時運用の無期限スケジュール・保持管理は次段階で、本MVPの有限上限を無断解除しません。

| API | 認可 |
|---|---|
| `GET /api/state` | viewer、同じownerの予定/結果のみ |
| `POST /api/jobs` / `.../:id/disable` | viewer、同じownerのみ |
| `POST /api/runs/:id/cancel` | viewer、同じownerのみ |
| `POST /api/claim` `{protocol:"absolute-deadline-v1",provider?}` | worker、同じowner、固定profileのみ。旧workerは拒否 |
| `POST /api/runs/:id/heartbeat` / `complete` | 取得したworker・owner・lease tokenが一致 |
| `POST /api/tick` `{at}` / `GET /api/ticks/:id` | localモードのviewerのみ、本番では拒否 |

認可情報はsecret `AUTH_JSON`の `[{id,owner,role,group,hash}]`。hashは32byte以上のランダムBearer tokenのSHA-256 hexです。viewerとworkerを分離し、各workerに固有id/tokenを割り当てます。`group`は同じ認証アカウント/サブスクを使うworker群で共通にします（省略時はowner）。tokenは送信経路上のsecretであり、本番はHTTPS必須。未設定・不正値はfail closed、CORS許可なし、結果はno-storeです。

`LIMITS_JSON`（管理者設定）で**全worker・全owner横断**の同時実行上限を変更できます。

```json
{"models":{"codex-luna":1,"pi-swe2":1},"groups":{"shared-subscription":1}}
```

model上限とgroup上限を同時に満たすjobだけを単一SQLの原子的claimで取得します。0は停止、負数/非整数/17以上は設定エラーです。同じCLI/アカウントを増設しても上限は増えません。低下させた上限は新規claimに即適用し、実行中を強制終了しません。CLIをこの仕組み外で手動使用した分や、異なるD1へ分散したworkerはこの台帳では数えられません。groupは正しい共有アカウントに対応させてください。

通常のworker pollingは30秒間隔です（`POLL_INTERVAL_MS`: 1000〜600000）。idle polling自体もHTTP/D1の負荷です。詳細: [設計・安全境界](docs/architecture.md)、[実証記録と月換算](docs/acceptance.md)。

実時間の有限試験は`node --import tsx scripts/realtime-check.ts`で実行できます。実時間60秒間隔で2回だけ受付け、実pollerプロセスでCLI fixture 2件とgeneric fixture 2件の保存まで確認し終了します（外部モデル呼出なし、約65秒）。上記`--live`の手動tick模擬とは別の証拠です。

## 本番化前のユーザー判断とrollback

1. draft PRレビューとmainへのマージ判断。
2. Cloudflareアカウント/プラン・D1作成・deploy許可、HTTPSルートと認証方式。現設定のダミーDB IDは本番使用不可。
3. 本番専用viewer/worker secretとowner/group割当、model/group上限。開発tokenを再利用しない。
4. 実行頻度・時刻・タイムゾーン・処理対象・モデル枠の利用方針。決定後にのみcronを追加し`SCHEDULE_ENABLED=true`へ。MODEはproductionへ。
5. WSL常駐方式、D1/CLIログの保持期間、認証失効時の運用。今はサービス登録せず、停止中の既存サービスも再開していません。

Cloudflare料金の厳密hard capは提供しません。実行回数・時間・出力量の制限はアプリ上の安全弁です。

Rollback: cronを無効化→対象jobをdisable→workerを終了→以前のWorker versionへ戻します。実行中の予約枠は停止確認かdeadline後に解放します。D1は削除せず保全し、schema変更を戻す前にexport/互換性を確認します。ローカルではこのタスクのWrangler/workerプロセスだけを終了します。
# TAKT execution adapter

Development tasks default to programmatic orchestration with the pinned TAKT `simple` workflow. Setup, preserved user runtime profiles, capacity reservations, interruption behavior and rollback: [TAKT adapter](docs/takt-adapter.md).
