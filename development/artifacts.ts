import {writeFile,readFile,lstat,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {fingerprint} from './operations.ts';
import type {RepositoryId} from '../shared/repositories.ts';

export type LocalArtifact={version:1;taskId:string;owner:string;repoId:RepositoryId;baseRef:string;baseSha:string;headSha:string;branch:string;contentHash:string;validation:string;checks:string[][];mode:'local_only'|'published';execution?:unknown};
export type SavedArtifact=LocalArtifact&{artifactId:string};
/** modelの書込範囲外へ排他的に保存する。既存成果物との不一致は上書きせず停止する。 */
export async function saveArtifact(root:string,artifact:LocalArtifact):Promise<SavedArtifact> {
  const rootStat=await lstat(root);
  if(await realpath(root)!==root||!rootStat.isDirectory()||(rootStat.mode&0o077)!==0)throw Error('untrusted_artifact_path');
  const artifactId=fingerprint(artifact),path=join(root,artifactId+'.json'),serialized=JSON.stringify({...artifact,artifactId});
  try{await writeFile(path,serialized,{flag:'wx',mode:0o600});}
  catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;const stat=await lstat(path);if(await realpath(path)!==path||!stat.isFile()||stat.nlink!==1||(stat.mode&0o077)!==0||await readFile(path,'utf8')!==serialized)throw Error('artifact_conflict');}
  return {...artifact,artifactId};
}
/** local-onlyは正常終端。設定変更による既存taskの公開昇格は禁止し、後日公開は独立したpublication承認・台帳だけで行う。 */
export async function finishArtifact(artifact:SavedArtifact,mode:'local_only'|'published',publish:()=>Promise<{url:string}>) {
  const {artifactId,...manifest}=artifact;
  if(fingerprint(manifest)!==artifactId||artifact.mode!==mode)throw Error('artifact_approval_mismatch');
  if(mode==='local_only')return {...artifact,outcome:'local_only' as const};
  const pr=await publish();return {...artifact,outcome:'published' as const,prUrl:pr.url};
}
