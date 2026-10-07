import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {validateWatchStorage} from './watch-adapter.ts';

/** D1受付や認証参照より前に、UUIDと公式clone名を含む保存名の上限を確認する。 */
export function watchAcceptanceRuns(parent:string,leaf:string){
 if(!/^[a-f0-9]{4}$/.test(leaf))throw Error('invalid_run_leaf');
 const runs=resolve(parent,leaf);
 validateWatchStorage(join(runs,'00000000-0000-4000-8000-000000000000','clones'));
 return runs;
}

/** 提供v3の工程モデルを暗黙に差し替えない。コピーしたbytesを検証する。 */
export function verifyAcceptanceRuntime(bytes:Uint8Array){
 const hash=createHash('sha256').update(bytes).digest('hex');
 if(hash!=='89140cbb8d83ca51a94ae3f2e471a219764a79531feb131514468b65a11fcefa')throw Error('acceptance_runtime_hash_mismatch');
 return hash;
}
