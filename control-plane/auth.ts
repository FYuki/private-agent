import {Fault,type Principal} from '../shared/contracts.ts';
export async function authenticate(req:Request,mode:string,auth:string|undefined):Promise<Principal>{
  const url=new URL(req.url);
  if(mode==='local' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Fault(403,'localhost_only');
  if(mode!=='local' && (mode!=='production'||url.protocol!=='https:'))throw new Fault(503,'authentication_not_configured');
  const token=req.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/)?.[1];
  if(!token)throw new Fault(401,'unauthorized');
  let principals:Principal[];try{principals=JSON.parse(auth||'[]');}catch{throw new Fault(503,'authentication_not_configured');}
  if(!Array.isArray(principals)||!principals.length)throw new Fault(503,'authentication_not_configured');
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))).map(x=>x.toString(16).padStart(2,'0')).join('');
  const p=principals.find(p=>p.hash===digest && /^[a-zA-Z0-9_-]{1,64}$/.test(p.owner)&&/^[a-zA-Z0-9_-]{1,64}$/.test(p.id)&&['viewer','worker'].includes(p.role));
  if(!p)throw new Fault(401,'unauthorized');return p;
}
