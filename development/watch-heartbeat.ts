/** 一時的なHTTP障害は次tickで再試行する。確認済み取消は配送成功まで保持する。 */
export function watchHeartbeat(heartbeat:()=>Promise<{cancelRequested?:boolean}>,cancel:()=>Promise<void>,report:(phase:'heartbeat'|'cancel',error:unknown)=>void){
 let busy=false,cancelRequested=false;
 return async()=>{
  if(busy)return;busy=true;
  try{
   try{cancelRequested=(await heartbeat()).cancelRequested===true||cancelRequested;}catch(e){report('heartbeat',e);}
   if(cancelRequested){try{await cancel();cancelRequested=false;}catch(e){report('cancel',e);}}
  }finally{busy=false;}
 };
}
