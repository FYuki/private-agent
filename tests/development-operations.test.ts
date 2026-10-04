import test from 'node:test';
import assert from 'node:assert/strict';
import { operation,type Ledger,type Reservation } from '../development/operations.ts';
import { publish,verifyRepositoryMetadata,type GitHubPublisher } from '../development/publisher.ts';
test('public publishing requires explicit administrator visibility and keeps repository identity and push checks',()=>{
 const metadata={id:1400010158,private:false,permissions:{push:true}};
 assert.throws(()=>verifyRepositoryMetadata(metadata),/visibility/);
 assert.doesNotThrow(()=>verifyRepositoryMetadata(metadata,'public'));
 assert.throws(()=>verifyRepositoryMetadata({...metadata,id:1},'public'),/identity/);
 assert.throws(()=>verifyRepositoryMetadata({...metadata,permissions:{push:false}},'public'),/identity/);
 assert.throws(()=>verifyRepositoryMetadata({...metadata,private:true},'public'),/visibility/);
});
function ledger(){const rows=new Map<string,Reservation>();const api:Ledger=async(name,hash,result)=>{const key=name+hash;let row=rows.get(key);const fresh=!row;if(!row){row={state:'reserved',result:null};rows.set(key,row);}if(result!==undefined){row.state='completed';row.result=result;}return {...row,fresh};};return api;}
test('uncertain operations reconcile without repeating writes, including restart',async()=>{
 const db=ledger();let writes=0,visible=false;
 await assert.rejects(operation(db,'push',{sha:'a'},async()=>{writes++;throw Error();},async()=>undefined),/blocked/);
 await assert.rejects(operation(db,'push',{sha:'a'},async()=>{writes++;return 'bad';},async()=>undefined),/blocked/);
 visible=true;assert.equal(await operation(db,'push',{sha:'a'},async()=>{writes++;return 'bad';},async()=>visible?'confirmed':undefined),'confirmed');assert.equal(writes,1);
 assert.equal(await operation(db,'push',{sha:'a'},async()=>{throw Error();}),'confirmed');
});
test('publication requires authorization and private repository; lost responses are reconciled',async()=>{
 let pushes=0,prs=0,sha:string|undefined,url:{url:string}|undefined,privateRepo=true;
 const github:GitHubPublisher={async verifyRepository(){if(!privateRepo)throw Error('private_required');},async branchSha(){return sha;},async push(_b,s){pushes++;sha=s;throw Error('lost');},async findPullRequest(){return url;},async createPullRequest(){prs++;url={url:'https://github.com/FYuki/private-agent/pull/99'};throw Error('lost');}};
 const db=ledger();await assert.rejects(publish(db,github,'branch','base','abc',false),/authorized/);assert.equal(pushes,0);
 privateRepo=false;await assert.rejects(publish(db,github,'branch','base','abc',true),/private/);assert.equal(pushes,0);
 privateRepo=true;assert.deepEqual(await publish(db,github,'branch','base','abc',true),url);await publish(db,github,'branch','base','abc',true);assert.equal(pushes,1);assert.equal(prs,1);
});
