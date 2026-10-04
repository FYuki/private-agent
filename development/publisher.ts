import { operation,type Ledger } from './operations.ts';

export function verifyRepositoryMetadata(info:{id?:number;private?:boolean;permissions?:{push?:boolean}},visibility:'private'|'public'='private',expectedId=1400010158,requirePush=true){
 if(!['private','public'].includes(visibility)||info.id!==expectedId||info.private!==(visibility==='private')||(requirePush&&info.permissions?.push!==true))throw Error('repository_identity_or_visibility_mismatch');
}

export interface GitHubPublisher {
 verifyRepository():Promise<void>;
 branchSha(branch:string):Promise<string|undefined>;
 push(branch:string,sha:string):Promise<void>;
 findPullRequest(branch:string,base:string,sha:string):Promise<{url:string}|undefined>;
 createPullRequest(branch:string,base:string,sha:string):Promise<{url:string}>;
}
/** 外部書込の権限は管理設定。モデル出力やタスク本文から決定しない。 */
export async function publish(ledger:Ledger,github:GitHubPublisher,branch:string,base:string,sha:string,authorized:boolean){
 if(!authorized)throw new Error('publication_not_authorized');
 await github.verifyRepository();
 await operation(ledger,'push',{branch,sha},async()=>{await github.verifyRepository();await github.push(branch,sha);return {sha};},async()=>await github.branchSha(branch)===sha?{sha}:undefined);
 return operation(ledger,'pull-request',{branch,base,sha},async()=>{await github.verifyRepository();return github.createPullRequest(branch,base,sha);},()=>github.findPullRequest(branch,base,sha));
}
