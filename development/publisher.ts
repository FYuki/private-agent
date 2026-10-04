import { operation,type Ledger } from './operations.ts';

export interface GitHubPublisher {
 verifyPrivate():Promise<void>;
 branchSha(branch:string):Promise<string|undefined>;
 push(branch:string,sha:string):Promise<void>;
 findPullRequest(branch:string,base:string,sha:string):Promise<{url:string}|undefined>;
 createPullRequest(branch:string,base:string,sha:string):Promise<{url:string}>;
}
/** 外部書込の権限は管理設定。モデル出力やタスク本文から決定しない。 */
export async function publish(ledger:Ledger,github:GitHubPublisher,branch:string,base:string,sha:string,authorized:boolean){
 if(!authorized)throw new Error('publication_not_authorized');
 await github.verifyPrivate();
 await operation(ledger,'push',{branch,sha},async()=>{await github.verifyPrivate();await github.push(branch,sha);return {sha};},async()=>await github.branchSha(branch)===sha?{sha}:undefined);
 return operation(ledger,'pull-request',{branch,base,sha},async()=>{await github.verifyPrivate();return github.createPullRequest(branch,base,sha);},()=>github.findPullRequest(branch,base,sha));
}
