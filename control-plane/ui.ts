export const html=`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Private Agent</title><style>
body{font:16px system-ui,sans-serif;background:#f3f5f7;color:#14283a;margin:auto;max-width:720px;padding:24px}h1{font-size:28px;margin-bottom:4px}p{line-height:1.6}input,button{font:inherit;padding:12px;border:1px solid #bcc9d2;border-radius:8px}input{width:100%;box-sizing:border-box}button{background:#173e56;color:white;margin:12px 6px 0 0;cursor:pointer}article{background:white;border:1px solid #dbe3e9;border-radius:12px;padding:18px;margin:14px 0;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.6}.muted{color:#516573;font-size:14px}.state{font-weight:700}label{display:block;margin-top:24px}h2{font-size:20px;margin-top:30px}
</style><h1>Private Agent</h1><p class="muted">定期タスクと実行結果</p><form id="login"><label for="token">閲覧トークン</label><input id="token" type="password" autocomplete="off" required><button>接続</button></form><div id="actions" hidden><button id="refresh">更新</button><button id="logout">ログアウト</button></div><p id="status" role="status">トークンはこの画面を閉じると消えます。</p><main id="content"></main><script src="/app.js"></script></html>`;
export const script=`
const $=id=>document.getElementById(id);
let session={generation:0,token:'',controller:new AbortController()};
function changeSession(token){
  session.controller.abort();
  session={generation:session.generation+1,token,controller:new AbortController()};
  $('content').replaceChildren();
  $('status').textContent=token?'接続中…':'ログアウトしました。';
  $('actions').hidden=!token;
}
const current=s=>s.generation===session.generation&&!s.controller.signal.aborted;
async function api(path,body,s){
  const r=await fetch(path,{method:body?'POST':'GET',signal:s.controller.signal,
    headers:{Authorization:'Bearer '+s.token,'Content-Type':'application/json'},
    ...(body?{body:JSON.stringify(body)}:{})});
  if(!r.ok)throw Error('取得できません ('+r.status+')');
  return r.json();
}
function el(tag,text,cls){const n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;}
async function refresh(s=session){
  if(!s.token||!current(s))return;
  try{
    const data=await api('/api/state',undefined,s);
    // Abort is best-effort: completed responses/body parsing can still resolve late.
    if(!current(s))return;
    $('content').replaceChildren();
    $('content').append(el('h2','予定'));
    for(const j of data.jobs){
      const a=el('article','');
      a.append(el('strong',j.name),el('p',j.provider+(j.character_id?' / '+j.character_id:'')+' · '+(j.enabled?'設定有効':'停止中')),
        el('p',new Date(j.start_at).toLocaleString()+' / '+j.interval_seconds+'秒ごと / 最大'+j.max_runs+'回','muted'));
      $('content').append(a);
    }
    if(!data.jobs.length)$('content').append(el('p','予定はありません。'));
    $('content').append(el('h2','実行結果'));
    for(const r of data.runs){
      const a=el('article','');
      a.append(el('p',r.state+' · 試行 '+r.attempt,'state'),el('p',new Date(r.due_at).toLocaleString(),'muted'),el('pre',r.result||r.error||'結果待ち'));
      if(['starting','queued','running'].includes(r.state)){
        const b=el('button','キャンセル');
        b.onclick=async()=>{
          if(!current(s))return;
          try{await api('/api/runs/'+r.id+'/cancel',{},s);if(current(s))await refresh(s);}
          catch(e){if(current(s))$('status').textContent=e.message;}
        };
        a.append(b);
      }
      $('content').append(a);
    }
    $('status').textContent='更新: '+new Date().toLocaleTimeString()+' · 出力は未検証のモデル応答です。';
  }catch(e){if(current(s))$('status').textContent=e.message;}
}
$('login').onsubmit=e=>{e.preventDefault();const token=$('token').value;$('token').value='';changeSession(token);return refresh();};
$('refresh').onclick=()=>refresh();
$('logout').onclick=()=>changeSession('');
`;
