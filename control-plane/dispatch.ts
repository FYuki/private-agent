import type { Store } from './store.ts';

export async function recoverStarting(store: Store, owner?: string) {
  const ownerFilter = owner === undefined ? '' : ' AND owner=?';
  const ownerArgs = owner === undefined ? [] : [owner];
  const upper = await store.q(`SELECT MAX(id) AS id FROM runs WHERE state='starting'${ownerFilter}`, ...ownerArgs).first<{id:string|null}>();
  const ids: string[] = [];
  if (upper?.id == null) return ids;
  let cursor: string | undefined;
  while (true) {
    const pending = (await store.q(`SELECT id FROM runs WHERE state='starting'${ownerFilter} AND id<=?${cursor === undefined ? '' : ' AND id>?'} ORDER BY id LIMIT 100`, ...ownerArgs, upper.id, ...(cursor === undefined ? [] : [cursor])).all<{id:string}>()).results;
    if (pending.length === 0) break;
    for (const run of pending) {
      await store.activate(run.id);
      if (owner !== undefined) ids.push(run.id);
    }
    // Ineligible rows remain starting; advance by selection rather than update success.
    cursor = pending[pending.length - 1].id;
  }
  return ids;
}

export async function dispatch(store: Store, at: number, owner?: string) {
  const admitted = await store.tick(at, owner, false);
  const ids = await recoverStarting(store, owner);
  return {enqueued: admitted.enqueued, skipped: admitted.skipped, ids};
}
