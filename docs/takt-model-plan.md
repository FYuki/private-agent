# TAKT モデル計画の契約

固定された公式 TAKT 0.68.0 の `OptionsBuilder` を用いて、展開した各 leaf workflow の step に対する provider/model/effort を解決する。phase 2/3 の合成を含む実行側と同じ profile options の優先順位を使う。これは実行前の資源計画であり、実行済みの記録ではない。

loop monitor は cycle の最後の step がトリガーになる。judge の明示 seat、step/persona routing がなければ、公式 `resolveLoopMonitorJudgeProviderModel` に従ってトリガーの provider/model/options を継承する。たとえば既定 Luna xhigh、fix が Sol medium の場合、未指定の loop judge は Sol medium になる。judge 解決後の runtime options も公式 builder で再合成する。

`compiled.json` の `modelPlanVersion: 2` と `conditionalCalls`、manifest の `resources.conditional` に、各 judge の workflow、cycle、threshold、trigger、解決元、profile 候補と `executed: false` を保存する。実行しなかった候補を成功・レビュー・承認として数えない。実際の呼び出し回数や各 phase の監査は実行ログに基づく別の証拠が必要となる。

この変更では固定 profile のみを受け付ける。pool、ladder、auto-routing、未検証 provider へ黙って切り替えない。assistant、selector、review-completion-judge の通常 seat と、トリガー依存の loop-judge を区別する。呼び出す可能性がある全モデルを予約し、同時 provider process 1、1 run 最大120呼び出し、1呼び出し20分、無通信10分、run既定4時間／最大24時間の境界を維持する。

検証は `npm run check`、`npm test` と `node --import tsx scripts/takt-config-check.ts`。公式 package のみを読み、provider や稼働 run を呼ばない。トリガーの effort 継承、明示 seat、persona/qualified step 上書き、未検証 provider 拒否、未実行フラグを検査する。

複数観点 builtin はこの変更では有効化していない。実行可能な workflow は引き続き `simple`。次の変更では、承認済み builtin registry、入れ子の最終 gate と COMPLETE 伝播の検証、選択されたレビュアーの記録、step 単位の並列上限と D1 資源予約を一体で追加する。公式 `default` の質問回答による早期 COMPLETE や `review` の REJECT→COMPLETE は承認に使えない。
