import { createHash } from 'node:crypto';

export type Reservation={fresh?:boolean;state:string;result:string|null};
export type Ledger=(name:string,fingerprint:string,result?:string)=>Promise<Reservation>;
export const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** 応答不明は成功を照合できたときだけ確定する。予約済みの操作を再送しない。 */
export async function operation<T>(ledger:Ledger,name:string,input:unknown,execute:()=>Promise<T>,reconcile?:()=>Promise<T|undefined>):Promise<T>{
 const hash=fingerprint(input),reservation=await ledger(name,hash);
 if(reservation.state==='completed'&&reservation.result!==null)return JSON.parse(reservation.result) as T;
 let result:T|undefined;
 if(!reservation.fresh){result=await reconcile?.();if(result===undefined)throw new Error('operation_blocked');}
 else{try{result=await execute();}catch{result=await reconcile?.();if(result===undefined)throw new Error('operation_blocked');}}
 await ledger(name,hash,JSON.stringify(result));return result;
}
