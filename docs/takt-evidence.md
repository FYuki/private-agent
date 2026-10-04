# TAKT adapter 受け入れ証跡

2026-10-04 UTC、Ubuntu WSL。実アカウントへdeploy・cron有効化・課金resource作成はしていない。

## 実際に確認した範囲

- 添付config/runtimeを公式TAKT 0.68.0 schemaでparseし、simpleとremediationの11 agent stepを公式loaderで展開。model/effortは原本どおり。
- config原本 SHA-256 `4632ade624d0f6339f3d88e70106afcae068b6a6ba1251e611e3071ae7bb2928`、runtime原本 `c037531181a9ba8201e1aaa01ef2330bd95c00a3ccfbe06ac65e299c6a82c87c`。原本auto_pr=true、実行設定のみfalse。
- 64 unit/契約試験、TypeScript、Workers dry-run build。排他lock、provider失敗、silent timeout、SIGINT耐性の子孫終了、120呼出上限、複数tag競合、未検証provider拒否、結果REJECT/不完全なCOMPLETE拒否を含む。
- SQLite仮想時計で75分のheartbeat継続、2時間期限、worker crash後の枠保持、owner/worker/tokenでfenceした停止ACK、Sol/Luna両modelと共通契約枠を検証。1時間以上の実機試験はしていない。
- 実local D1 migration0001–0004。実local Workflows 4 instances、2回分の模擬schedule、4成功。TAKT用APIの長時間予算・進捗・cancel fenceを実D1で確認。
- official MCP SDK stdio試験。390×844 ChromiumでTAKT選択→programmatic連動、送信、cancel、logoutを確認。日本語表示は既存Windowsフォントを検証processだけで参照して目視確認した。global font設定は変更していない。
- 実bwrapで`.git`通常ファイル条件を確認。元Git pointerを保持し、remoteなしsnapshotの参照成功、snapshot書込とproject config書込を拒否、継承APIキー/GitHub tokenの遮断を合成sentinelで確認。

## 実TAKT + ChatGPTログイン

合成task: `greeting()`を`hello`から`hello world`へ変更し、node:testを1つ追加。既存のChatGPTログインをreadonly mount、公式Codex CLI 0.159.0、APIキーfallbackなし。合成試験自体はcommit/push/PRを実施していない。

成功run `aacf380e-6bc8-4e7e-890c-e309182efa7b` / slug `20261004-122813-small-synthetic-implementation`。986.034秒（約16分26秒）、provider起動20回、観測した同時process最大1、終了時0・lock残存なし。

| stage | iteration | status | matchedRuleIndex |
|---|---:|---|---:|
| plan | 1 | done | 0 |
| write_tests | 2 | done | 0 |
| implement | 3 | done | 0 |
| review | 4 | done | 0（approved） |
| supervise | 5 | done | 1（APPROVE） |

meta completedと最後のcanonical workflow_completeを照合し、adapterのacceptedResultもapprovedを返した。TAKT phase usageには実Solが記録された。内部Agentについては公式runtime解決からLuna/xhighを計上しているが、この試験のphase usageは内部呼出を個別表示しないため、Luna実行の個別証跡としては扱わない。新しいwrapper activityにはmodel/effortを記録する。

最初のrunは元Git管理領域を完全maskしたため、TAKT selectorがGit worktreeを検出できず停止した。変更を公開せず失敗扱いにし、認証・remoteを持たない読み取り専用Git snapshotを追加して新規runで成功した。保存状態の書換えや無断resumeはしていない。

## 未実施・後続判断

- TAKT経由の成果から実GitHub PRまでを通す再試験は未実施。公開部分はPR6で検証済みのledger/publisherを再利用し、今回もそのfixtureを通している。先行PR5はその実Codex公開試験の証跡で、未使用のlabel関数を本体へ取り込まないためdraftのまま保持。
- builtin defaultの多観点並列review、Claude/Pi、任意workflow/任意resume、production ingress/dot登録は未対応。simple以外へ暗黙に切り替えない。
- 本番のCloudflare認証・契約・secret・deploy・cron時刻、main mergeは別途ユーザー判断。開発用tokenは本番へ転用しない。
