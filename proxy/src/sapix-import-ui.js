const CLIENT = String.raw`(function(){
  'use strict';
  const $ = id => document.getElementById(id);
  const state = {csrf:'', authenticated:false, files:[], selected:new Set(), scanId:'', model:null, jobs:[], busy:false, timer:null};
  const active = job => ['queued','running','publishing'].includes(job.status);
  const recovering = job => active(job) || job.recovering;
  const labels = {queued:'開始を待っています',running:'取り込み中',publishing:'サイトへの反映を確認中',completed:'取り込み完了',failed:'処理が中断しました',needs_attention:'確認が必要です',cancelled:'取り消し済み'};
  const make = (tag, content, className) => {const node=document.createElement(tag);if(content!==undefined)node.textContent=content;if(className)node.className=className;return node;};
  const message = (value, error) => {$('message').textContent=value||'';$('message').hidden=!value;$('message').className=error?'notice error':'notice';};
  async function api(path,body){
    const options={credentials:'same-origin',headers:{Accept:'application/json'}};
    if(body!==undefined){options.method='POST';options.headers['Content-Type']='application/json';options.headers['x-studio-csrf']=state.csrf;options.body=JSON.stringify(body);}
    let response;try{response=await fetch(path.startsWith('/api/')?path:'/studio/api/sapix-import'+path,options);}catch{throw new Error('通信できませんでした。作成履歴を確認してから再試行してください。');}
    const value=await response.json();
    if(response.status===401){state.authenticated=false;clearTimeout(state.timer);$('workspace').hidden=true;$('gate').hidden=false;throw new Error('Studio の Google 接続が必要です。');}
    if(!response.ok)throw new Error((value.message||'操作を完了できませんでした。画面を更新して再試行してください。')+(/^models_[a-z0-9_]{1,60}$/.test(value.diagnostic||'')?'（確認コード：'+value.diagnostic+'）':''));
    return value;
  }
  function controls(){const n=state.selected.size;$('start').textContent=n?'選択した '+n+' 件を確認する':'取り込む資料を選んでください';$('start').disabled=state.busy||!n||n>10||state.jobs.some(recovering);$('reload').disabled=state.busy;$('count').textContent=state.files.length+' 件の候補 / '+n+' 件選択';}
  function renderFiles(){
    $('files').replaceChildren();
    if(!state.files.length){$('files').append(make('p','条件に合う未取り込み資料はありません。','empty'));controls();return;}
    for(const file of state.files){const label=make('label',undefined,'file');const input=make('input');input.type='checkbox';input.checked=state.selected.has(file.id);input.addEventListener('change',()=>{if(input.checked)state.selected.add(file.id);else state.selected.delete(file.id);controls();});const copy=make('span');copy.append(make('strong',file.name),make('span',(file.unitPath?file.unitPath+' · ':'')+'作成 '+new Date(file.createdTime).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'}),'meta'));label.append(input,copy);$('files').append(label);}
    controls();
  }
  function renderJobs(){
    $('jobs').replaceChildren();
    if(!state.jobs.length)$('jobs').append(make('p','取り込み履歴はまだありません。','empty'));
    for(const job of state.jobs){const card=make('article',undefined,'job');card.append(make('span',labels[job.status]||'状況を確認中','badge'),make('h3',(job.files||[]).map(file=>file.name).join('、')),make('p',job.message||''));if(job.error)card.append(make('p',job.error,'error'));if(job.model)card.append(make('p','モデル：'+job.model.name,'meta'));
      if(active(job)){const progress=make('progress');progress.max=100;progress.value=Number.isFinite(job.progress)?job.progress:0;progress.setAttribute('aria-label','取り込みの進捗');card.append(progress);}
      if(job.result?.url){try{const url=new URL(job.result.url);if(url.protocol==='https:'&&!url.username&&!url.password){const link=make('a','追加された問題を開く','button');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';card.append(link);}}catch{}}
      const actions=make('div',undefined,'actions');
      for(const action of (['queued','running'].includes(job.status)||((job.status==='needs_attention'||job.recovering)&&job.stage!=='publishing'))?['cancel']:[]){const button=make('button','取り消す','secondary');button.type='button';button.disabled=state.busy;button.addEventListener('click',()=>jobAction(job.id,action));actions.append(button);}
      if(['failed','needs_attention'].includes(job.status)){const button=make('button','再試行する','secondary');button.type='button';button.disabled=state.busy||state.jobs.some(other=>other.id!==job.id&&recovering(other));button.addEventListener('click',()=>jobAction(job.id,'retry'));actions.append(button);}
      card.append(actions);$('jobs').append(card);
    }
    clearTimeout(state.timer);if(state.authenticated&&!document.hidden&&state.jobs.some(recovering))state.timer=setTimeout(refreshJobs,8000);controls();
  }
  async function refreshJobs(){if(!state.authenticated)return;try{const value=await api('/jobs');state.jobs=value.jobs;renderJobs();}catch(error){message(error.message,true);if(state.authenticated)state.timer=setTimeout(refreshJobs,15000);}}
  async function jobAction(id,action){state.busy=true;controls();try{await api('/jobs/'+id+'/'+action,{});await refreshJobs();}catch(error){message(error.message,true);}finally{state.busy=false;renderJobs();}}
  async function scan(){if(state.busy)return;state.busy=true;controls();message('Google Drive の候補を確認しています…');try{const value=await api('/candidates');state.files=value.files;state.model=value.model;state.scanId=value.scanId;state.selected.clear();$('model').textContent='今回のモデル：'+value.model.name+'（'+value.model.id+'）';renderFiles();message('候補を確認し、取り込む資料を選んでください。');}catch(error){message(error.message,true);}finally{state.busy=false;controls();}}
  function confirm(){if(state.busy||!state.selected.size||state.selected.size>10||state.jobs.some(recovering))return;$('confirm-files').replaceChildren();for(const file of state.files.filter(file=>state.selected.has(file.id)))$('confirm-files').append(make('li',file.name));$('confirm-model').textContent=state.model.name+' で問題を作成し、SAPIX の一覧に追加します。';$('confirm').showModal();}
  async function start(){if(state.busy)return;state.busy=true;$('confirm-start').disabled=true;controls();try{const value=await api('/jobs',{scanId:state.scanId,fileIds:[...state.selected]});$('confirm').close();state.selected.clear();renderFiles();message('取り込みを受け付けました。画面を閉じても処理は続きます。');await refreshJobs();$('history').scrollIntoView({behavior:'smooth'});}catch(error){$('confirm-error').textContent=error.message;message(error.message,true);}finally{state.busy=false;$('confirm-start').disabled=false;controls();}}
  $('reload').addEventListener('click',scan);$('refresh-jobs').addEventListener('click',refreshJobs);$('start').addEventListener('click',confirm);$('confirm-start').addEventListener('click',start);$('confirm-cancel').addEventListener('click',()=>{$('confirm').close();$('confirm-error').textContent='';});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)clearTimeout(state.timer);else refreshJobs();});
  (async()=>{try{const session=await api('/api/studio/session');state.authenticated=session.authenticated===true;state.csrf=session.csrf||'';$('gate').hidden=state.authenticated;$('workspace').hidden=!state.authenticated;if(state.authenticated){await refreshJobs();await scan();}}catch(error){message(error.message,true);}})();
})();`;

export function sapixImportPage() {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>SAPIX 資料を取り込む</title><style>
  :root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#233e36;background:#f5f7f2;line-height:1.65}*{box-sizing:border-box}body{margin:0}main{max-width:940px;margin:auto;padding:28px 20px 60px}a{color:#17644e}h1{font-size:30px;margin:24px 0 8px}h2{font-size:20px}h3{font-size:16px;overflow-wrap:anywhere}button,.button{font:inherit;display:inline-flex;align-items:center;justify-content:center;min-height:44px;border:1px solid #17644e;border-radius:9px;padding:9px 16px;background:#17644e;color:white;font-weight:650;text-decoration:none;cursor:pointer}button:disabled{opacity:.5;cursor:default}.secondary{background:white;color:#17644e;border-color:#cbd8cf}.panel{background:white;border:1px solid #dbe3dc;border-radius:16px;padding:22px;margin-top:24px}.intro,.meta,.empty{color:#63776b}.meta{display:block;font-size:12px}.file{display:flex;align-items:start;gap:13px;border-top:1px solid #e0e6df;padding:16px 0;cursor:pointer}.file strong{display:block;overflow-wrap:anywhere}.file input{width:21px;height:21px;flex:none;margin:3px 0;accent-color:#17644e}.row,.actions{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.actions{justify-content:flex-start;margin-top:12px}.notice{padding:14px;border-radius:9px;background:#eaf3e9;margin-top:20px}.error{color:#963e29;white-space:pre-wrap;overflow-wrap:anywhere}.notice.error{background:#fff0e9}.job{border-top:1px solid #dbe3dc;padding:18px 0}.badge{background:#eaf3e9;border-radius:20px;padding:4px 10px;font-size:12px}.job p{margin:8px 0}progress{display:block;width:100%;height:8px;margin:15px 0;accent-color:#17644e}dialog{max-width:560px;width:calc(100% - 30px);border:1px solid #dbe3dc;border-radius:16px;padding:25px;color:inherit}dialog::backdrop{background:#102f2399}li{overflow-wrap:anywhere}[hidden]{display:none!important}:focus-visible{outline:3px solid #d99d35;outline-offset:3px}@media(max-width:500px){main{padding:18px 14px 40px}.panel{padding:16px}h1{font-size:25px}.row{align-items:start}}
  </style></head><body><main><a href="/studio">← 教材スタジオ</a><h1>SAPIX の資料を取り込む</h1><p class="intro">Google Drive の候補から資料を選び、確認してから問題を追加します。<br>対象は <strong>2026年9月24日 0:00（日本時間）以降に作成された PDF・画像</strong>です。フォルダに移動した日時ではありません。取り込み済みのファイルは、更新されても再取り込みしません。</p>
  <div id="message" role="status" class="notice" hidden></div><section id="gate" class="panel"><h2>教材スタジオに接続</h2><p>Drive を読むため、教材スタジオの管理者 Google アカウントで接続します。</p><a class="button" href="/api/studio/google/start?return=sapix-import">Google に接続する</a></section>
  <div id="workspace" hidden><section class="panel"><div class="row"><h2>取り込む資料</h2><button id="reload" class="secondary" type="button">候補を更新</button></div><p id="model" class="meta"></p><p id="count" class="meta"></p><p class="meta">一度に10件まで選択できます。確認前に問題生成は行いません。</p><div id="files"></div><button id="start" type="button" disabled>取り込む資料を選んでください</button></section>
  <section class="panel" id="history"><div class="row"><h2>取り込み履歴</h2><button id="refresh-jobs" class="secondary" type="button">履歴を更新</button></div><div id="jobs"></div><p class="meta">作成状況は自動更新されます。画面を閉じてもクラウド処理は続きます。</p></section></div>
  <dialog id="confirm"><h2>この資料を取り込みますか</h2><ul id="confirm-files"></ul><p id="confirm-model"></p><p>生成には API の利用料が発生します。</p><p id="confirm-error" role="alert" class="error"></p><div class="actions"><button id="confirm-start" type="button">確認して取り込む</button><button id="confirm-cancel" class="secondary" type="button">戻る</button></div></dialog></main><script>${CLIENT}</script></body></html>`;
}
