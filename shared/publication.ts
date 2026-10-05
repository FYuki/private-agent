import {Fault,exact,object,str} from './contracts.ts';
import {repositoryPolicy,repositoryBranch,validationCommands,type RepositoryId} from './repositories.ts';

export const uuid=(v:unknown)=>{const s=str(v,36);if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(s))throw new Fault(400,'invalid_id');return s;};
export const sha=(v:unknown,n=40)=>{const s=str(v,n);if(!new RegExp('^[a-f0-9]{'+n+'}$').test(s))throw new Fault(400,'invalid_hash');return s;};
export async function digest(value:unknown){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))).map(x=>x.toString(16).padStart(2,'0')).join('');}
export type PublicationInput={taskId:string;artifactId:string;repoId:RepositoryId;headSha:string;baseRef:string;baseSha:string;remoteBaseSha:string;title:string;body:string;approved:true};
/** Explicit owner approval binds the artifact and all public PR text; no command or path input. */
export function publicationInput(value:unknown):PublicationInput{
 const v=object(value);exact(v,['taskId','artifactId','repoId','headSha','baseRef','baseSha','remoteBaseSha','title','body','approved']);
 const policy=repositoryPolicy(v.repoId);if(v.approved!==true||v.baseRef!==policy.baseRef)throw new Fault(400,'publication_approval_required');
 const title=str(v.title,160),body=str(v.body,8192);if(/[\r\n\x00-\x1f]/.test(title)||body.includes('\0'))throw new Fault(400,'invalid_publication_text');
 if(/(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|sk-[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{20,}\.|BEGIN [A-Z ]*PRIVATE KEY)/.test(title+'\n'+body))throw new Fault(400,'secret_detected');
 return {taskId:uuid(v.taskId),artifactId:sha(v.artifactId,64),repoId:v.repoId as RepositoryId,headSha:sha(v.headSha),baseRef:policy.baseRef,baseSha:sha(v.baseSha),remoteBaseSha:sha(v.remoteBaseSha),title,body,approved:true};
}
/** Verify the original immutable local-only manifest before granting a separate publication. */
export async function publicationArtifact(value:unknown,owner:string,input:PublicationInput){
 const v=object(value);const {artifactId,outcome,review,...manifest}=v;
 exact(manifest,['version','taskId','owner','repoId','baseRef','baseSha','headSha','branch','contentHash','validation','checks','mode','execution']);
 const policy=repositoryPolicy(input.repoId);
 if(artifactId!==input.artifactId||await digest(manifest)!==artifactId||manifest.version!==1||manifest.mode!=='local_only'||
   manifest.owner!==owner||manifest.taskId!==input.taskId||manifest.repoId!==input.repoId||manifest.headSha!==input.headSha||manifest.baseRef!==input.baseRef||manifest.baseSha!==input.baseSha||
   manifest.branch!==repositoryBranch(input.repoId,input.taskId)||manifest.validation!==policy.validation||JSON.stringify(manifest.checks)!==JSON.stringify(validationCommands(input.repoId)))throw new Fault(409,'artifact_approval_mismatch');
 sha(manifest.contentHash,64);
 return {...manifest,artifactId} as typeof manifest&{artifactId:string;branch:string;contentHash:string};
}
