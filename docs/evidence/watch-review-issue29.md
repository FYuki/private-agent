# Issue29: watchからEpic draft PRまでの実接続受入

2026-10-08 UTC（2026-10-09 JST）。[Issue29](https://github.com/FYuki/private-agent/issues/29)、接続実装[PR28](https://github.com/FYuki/private-agent/pull/28)。既存`epic/development-runner`をmainの`3c1fa657af189300581de2f46240fda860c27844`へfast-forwardして実行した。mainは変更していない。

## 成功した実行

- workflow: 固定TAKT 0.68.0の`private-agent-child-issue`。
- task: `ead65610-7ce9-4fb4-bf3a-401100304db4`。
- run: `20261008-151450-implement-using-only-the-files-5hojhw`。
- TAKT開始/終了: `2026-10-08T15:14:51.000Z` → `2026-10-08T15:34:55.989Z`、9工程、20分4.989秒。
- 工程: plan → write_tests → implement → 案件review → supervise APPROVE → gather → 必須quality-review approved → 指摘裁定（修正対象なし）→ final-gate APPROVE。
- providerは既存examples/taktのCodex Sol/Luna設定。config/runtime原本のハッシュが実行前後で一致。CodeRabbit CLI/APIは呼んでいない。
- provider wrapperのstarted/closedは32/32。watch停止後に成果物回収、固定hostの`npm run check` / `npm test`が成功。
- head: `8811bca95fd4299186777d2a5278727730b19277`。変更は`tests/text-boundary.test.ts`の48行追加だけ。
- artifact: `9d32f21e8e1c307c0807e17ce9bbbd7816890affed0e02b7696ec1dd4de3a271`。
- 独自レビュー合格をホストが照合し、[draft PR30](https://github.com/FYuki/private-agent/pull/30)を`epic/development-runner`宛に自動作成した。
- SQLite終端: succeeded、errorなし、hold_until=0。prepare/takt/test/commit/artifact/push/pull-requestの7操作がcompleted。
- 同じ設定/stateで再接続し、同じtask/artifact/PRへ復帰。対象headのPRは1件、追加モデル起動なし。

## 先行失敗を含む記録

| 試行 | 結果 | 修正 |
| --- | --- | --- |
| 起動前設定 | リポジトリ可視性の不一致。モデル未起動 | 実際のpublic設定を指定し、claim前のrepository照合を追加。server.stop後のSQLite二重closeも修正 |
| public01 | TAKTは9工程完了したが、ホストがworkflow参照不一致で拒否。公開なし | 公式opaque refは内容ではなく絶対source pathのhash。builtinを実行namespaceの`/opt/takt-runtime`配置で照合するよう修正 |
| public02 | 5工程目superviseでBLOCKED。公開なし | prompt内の元cwd/report絶対パスを同じ隔離`/workspace`へ解決するaliasを追加。GitとTAKT管理領域の読取専用性を維持 |
| public03 | 全経路成功、PR30自動作成 | 上記の終端・HEAD・artifact・PRを確認 |

失敗結果を成功に書き換えず、新規taskで再実行した。namespace stubでは元cwdからの読取り、Git ref変更拒否、MCP再接続、tell、取消を検証。CIの作業場所を`/tmp`に決め打ちしないよう試験を修正し、tell完了後にstubを解除する同期にした。

実行manifestと公開用生応答を含まないevidenceはローカル`.local/watch-review-issue29/`に保持。認証本文・provider生応答は本書へ転記しない。

## 適用範囲

正常な実モデル→公式watch→必須独自レビュー→固定host検証→artifact→実GitHub draft PRを受入済み。実モデルでの修正ループは今回は発生していない（既存公式Engineのmock試験で検証）。CodeRabbit同等品質、6時間実運転、通常profileへの運用切替は本試験の受入対象外。PR30のEpic mergeとPR28のmain mergeは行っていない。
