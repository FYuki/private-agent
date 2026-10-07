```markdown
# 広範品質レビュー

{{include:output-contracts/base-review-result}}

## サマリー
{確認結果と未確認の範囲}

## 検証した項目
| 観点 | 調べた契約・影響経路 | 証拠または該当しない理由 |
|------|--------------------|------------------------|
| 正しさ/セキュリティ/互換性/実装品質/テスト | {対象} | {根拠} |

{{include:output-contracts/base-review-non-finding-concerns}}
{{include:output-contracts/base-review-new-findings-category}}
{QUALITY-から始まる安定したfinding_id。重要度・発生条件・影響・根拠・改善案を記載}
{{include:output-contracts/base-review-persists}}
{{include:output-contracts/base-review-carry-over-findings}}
{{include:output-contracts/base-review-resolved-findings}}
{{include:output-contracts/base-review-adjudicated-out-of-scope}}
{{include:output-contracts/base-review-reopened-findings}}
{{include:output-contracts/base-review-reopened}}
{{include:output-contracts/base-review-rescan-evidence}}

## REJECT判定条件
{{include:output-contracts/base-review-rejection-gate}}
- finding_idのない指摘、根拠のない推測、単なる好みはblockingにしない。
```
