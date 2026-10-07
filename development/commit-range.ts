import {allowedRepositoryPath,type RepositoryId} from '../shared/repositories.ts';
import {fingerprint} from './operations.ts';
export type CommitRangeProof={version:1;commits:string[];digest:string};
/** hostが全中間commitを検証する。最終差分で消えた禁止変更も公開しない。 */
export async function verifyCommitRange(git:(args:string[])=>Promise<string>,repoId:RepositoryId,base:string,head:string):Promise<CommitRangeProof>{
 if(!/^[a-f0-9]{40}$/.test(base)||!/^[a-f0-9]{40}$/.test(head))throw Error('invalid_commit_range');
 const rows=(await git(['rev-list','--reverse','--parents','--max-count=121',base+'..'+head])).trim().split('\n').filter(Boolean);
 if(!rows.length||rows.length>120)throw Error('commit_limit');
 let parent=base,bytes=0;const commits:string[]=[],records:unknown[]=[],paths=new Set<string>();
 for(const row of rows){
  const parts=row.split(' ');if(parts.length!==2||parts[1]!==parent||!parts.every(p=>/^[a-f0-9]{40}$/.test(p)))throw Error('nonlinear_commit_range');
  const commit=parts[0];commits.push(commit);
  const files=(await git(['diff-tree','--no-commit-id','--name-only','--no-renames','-r','-z',parent,commit])).split('\0').filter(Boolean).sort();
  for(const path of files){
   if(!allowedRepositoryPath(repoId,path))throw Error('path_denied');paths.add(path);if(paths.size>20)throw Error('change_limit');
   const tree=await git(['ls-tree','-z',commit,'--',path]);if(!tree){records.push([commit,path,null]);continue;}
   const entry=tree.match(/^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)\0$/);
   if(!entry||entry[3]!==path)throw Error('invalid_artifact_file');
   const content=await git(['show',commit+':'+path]);bytes+=Buffer.byteLength(content);if(bytes>1048576)throw Error('history_size_limit');
   if(/(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|sk-[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{20,}\.|BEGIN [A-Z ]*PRIVATE KEY)/.test(content))throw Error('secret_detected');
   records.push([commit,path,entry[1],entry[2]]);
  }
  parent=commit;
 }
 if(parent!==head)throw Error('incomplete_commit_range');
 return {version:1,commits,digest:fingerprint({base,head,records})};
}
