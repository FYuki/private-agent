import {lstat,realpath,mkdir} from 'node:fs/promises';
import {isAbsolute,resolve,relative,sep} from 'node:path';
import {object,exact,str} from '../shared/contracts.ts';
import {repositoryPolicy,type RepositoryId} from '../shared/repositories.ts';

export type RepositoryBinding = {repoId:RepositoryId;root:string;worktrees:string;owners:string[];visibility:'private'|'public';publishAuthorized:boolean;approvedPublicationAllowed?:boolean};
/** 管理者だけが設定する配置。taskからroot・argv・公開権限を受け付けない。 */
export function repositoryBindings(value:unknown):RepositoryBinding[] {
  if(!Array.isArray(value)||value.length<1||value.length>2)throw Error('invalid_repository_registry');
  const ids=new Set<string>();
  return value.map(raw=>{
    const v=object(raw);exact(v,['repoId','root','worktrees','owners','visibility','publishAuthorized','approvedPublicationAllowed']);repositoryPolicy(v.repoId);
    const repoId=v.repoId as RepositoryId;if(ids.has(repoId))throw Error('duplicate_repository');ids.add(repoId);
    const root=str(v.root,4096),worktrees=str(v.worktrees,4096);
    for(const p of [root,worktrees])if(!isAbsolute(p)||resolve(p)!==p)throw Error('untrusted_admin_path');
    const contains=(parent:string,child:string)=>{
      const path=relative(parent,child);
      return path===''||(!isAbsolute(path)&&path!=='..'&&!path.startsWith('..'+sep));
    };
    if(contains(root,worktrees)||contains(worktrees,root))throw Error('overlapping_repository_paths');
    if(!Array.isArray(v.owners)||!v.owners.length||v.owners.length>16||v.owners.some(x=>typeof x!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(x)))throw Error('invalid_repository_owners');
    if(!['private','public'].includes(v.visibility as string)||typeof v.publishAuthorized!=='boolean')throw Error('invalid_repository_permission');
    if(v.approvedPublicationAllowed!==undefined&&typeof v.approvedPublicationAllowed!=='boolean')throw Error('invalid_repository_permission');
    return {repoId,root,worktrees,owners:[...new Set(v.owners as string[])],visibility:v.visibility as 'private'|'public',publishAuthorized:v.publishAuthorized,approvedPublicationAllowed:v.approvedPublicationAllowed===true};
  });
}
export function selectRepository(bindings:RepositoryBinding[],repoId:string,owner:string):RepositoryBinding {
  const binding=repositoryBindings(bindings).find(b=>b.repoId===repoId);
  if(!binding||!binding.owners.includes(owner))throw Error('repository_owner_not_allowed');
  return binding;
}
/** モデル起動前に配置を検証。symlink経由のroot・成果物保存先は許可しない。 */
export async function preflightRepository(binding:RepositoryBinding) {
  for(const path of [binding.root,binding.worktrees]){
    if(resolve(path)!==path||await realpath(path)!==path||!(await lstat(path)).isDirectory())throw Error('untrusted_admin_path');
  }
  const artifacts=binding.worktrees+'/.artifacts';await mkdir(artifacts,{recursive:true,mode:0o700});
  if(await realpath(artifacts)!==artifacts||((await lstat(artifacts)).mode&0o077)!==0)throw Error('untrusted_artifact_path');
  return artifacts;
}
