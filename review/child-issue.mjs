/** 子Issue・repo・開発経路とEpic宛ブランチ形式を検証し、不正値は実行前に拒否する。Git上の実在確認は呼出し側が担う。 */
export function validateChildContext(context) {
  if (!/^epic\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(context.epic ?? '') || context.epic.includes('..')) throw Error('epic_base_required');
  if (!/^(feature|fix|docs|infra|character)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(context.branch ?? '') || context.branch.includes('..')) throw Error('child_branch_required');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(context.repo ?? '')) throw Error('repository_required');
  if (!Number.isSafeInteger(context.issue) || context.issue < 1) throw Error('child_issue_required');
  if (!['takt', 'external'].includes(context.development)) throw Error('development_route_required');
}

/**
 * 実装・レビューの成功結果だけを公開処理へ渡す。例外や承認不足では公開しない。
 * 再実行でexecuteも再度呼ぶため、公開のみの再試行は保存済み承認を使う別入口に任せる。
 */
export async function runChildIssue(context, dependencies) {
  validateChildContext(context);
  const review = await dependencies.execute(context);
  if (review?.approved !== true) throw Error('review_not_approved');
  return dependencies.publish(context, review);
}

/** exit0や古いAPPROVEを採用せず、今回runの最後のレビューと最終ゲートを確認する。 */
export function assertReviewApproval(result, events, workflow) {
  const start = events.find(e => e.type === 'workflow_start');
  const quality = events.findLast(e => e.type === 'phase_complete' && e.step === 'quality-review' && e.phase === 3);
  const gate = events.findLast(e => e.type === 'step_complete' && e.step === 'final-gate' && e.workflow === 'peer-review');
  if (!result.success || result.exceeded || result.finalizationIssues?.length || start?.workflowName !== workflow ||
      events.at(-1)?.type !== 'workflow_complete' || !quality || quality.status !== 'done' || quality.content !== 'approved' ||
      !gate || gate.status !== 'done' || gate.matchedRuleIndex !== 0 || events.indexOf(quality) >= events.indexOf(gate)) {
    throw Error('review_not_approved');
  }
  return { approved: true };
}
