(function () {
  'use strict';
  if (document.getElementById('calculation-records')) return;
  const file = decodeURIComponent(location.pathname.split('/').pop());
  const index = file === 'index.html' || !file;
  const style = document.createElement('style');
  style.textContent = `.cr-panel{color:#233545;font:13px system-ui;position:relative;z-index:auto;box-sizing:border-box}.cr-top{display:flex;align-items:baseline;flex-wrap:wrap;gap:8px 18px;padding:6px 12px;background:#f5f7f4;border-bottom:1px solid #cfd6d0}.cr-top>details{flex:1;min-width:180px}.cr-panel button,.cr-panel input{font:inherit;padding:7px;margin:3px;border:1px solid #abbccc;border-radius:6px;background:#fff;color:#233545}.cr-panel summary{cursor:pointer;font-weight:500;line-height:1.6}.cr-panel ul{padding-left:22px;max-height:180px;overflow:auto}.cr-panel .cr-status{font-size:12px;overflow-wrap:anywhere}.cr-mark{font-weight:bold;min-width:40px;min-height:40px}.cr-panel button:focus-visible,.cr-panel summary:focus-visible{outline:3px solid #e4a349}.cr-grade{grid-column:1/-1;min-width:0;margin:5px 0 0;padding:0;border:0;background:transparent}.cr-grade>details>summary{color:#5b6a63;font-size:12px}.cr-controls{display:inline-flex;flex-wrap:wrap;align-items:center;gap:4px;padding:0}.cr-history{margin:0 0 4px}.cr-panel select{font:inherit;padding:7px;margin:3px}.cr-grade{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px}.cr-history[open]{flex-basis:100%}.cr-top p{margin:6px 0}.cr-top>details[open]{padding-bottom:6px}`;
  document.head.appendChild(style);
  const panel = document.createElement('section');
  panel.id = 'calculation-records'; panel.className = 'cr-panel cr-top';
  panel.innerHTML = '<a href="./index.html">← 計算力テスト一覧</a><details><summary>記録の同期・設定</summary><p class="cr-status" role="status"></p><button type="button" class="cr-sync">記録を同期 / Googleで接続</button><p>Google接続先：iwslatojp29@gmail.com。採点は端末に保存し、接続後に端末間で同期します。</p></details>';
  document.body.prepend(panel);
  const status = panel.querySelector('.cr-status');
  let store, cloud = {};
  const labels = { o: '〇', t: '△', x: '×' };
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); };
  const prefix = 'calc:' + file + ':';
  function render() {
    if (!store) return;
    const entries = store.getEntries();
    document.querySelectorAll('[data-cr-pid]').forEach(box => {
      const list = box.querySelector('ul'); list.replaceChildren();
      const rows = entries.filter(e => e.pid === box.dataset.crPid).sort((a,b) => b.value.d.localeCompare(a.value.d) || b.order-a.order);
      box.querySelector('.cr-history summary').textContent = 'やった記録（' + rows.length + '件）' + (rows.length ? ' 最新：' + rows[0].value.d + ' ' + labels[rows[0].value.r] : '');

      rows.forEach(e => {
        const li = document.createElement('li');
        li.append(document.createTextNode(e.value.d + ' ' + labels[e.value.r] + ' '));
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '取り消す';
        remove.onclick = () => { try { store.remove([e.id]); render(); } catch (_) { status.textContent = '取り消しを保存できませんでした。'; } };
        const edit = document.createElement('button'); edit.type='button'; edit.textContent='変更';
        edit.onclick = () => {
          const date=document.createElement('input'); date.type='date'; date.value=e.value.d; date.setAttribute('aria-label','変更する日付');
          const grade=document.createElement('select'); grade.setAttribute('aria-label','変更する採点');
          for(const r of ['o','t','x']){const option=document.createElement('option');option.value=r;option.textContent=labels[r];grade.append(option);}grade.value=e.value.r;
          const save=document.createElement('button');save.type='button';save.textContent='保存';
          save.onclick=()=>{try{store.put(e.pid,{...e.value,d:date.value,r:grade.value},e.id);render();}catch(_){status.textContent='変更を保存できませんでした。日付と保存設定を確認してください。';}};
          const cancel=document.createElement('button');cancel.type='button';cancel.textContent='戻る';cancel.onclick=render;
          li.replaceChildren(date,grade,save,cancel,remove);
        };
        remove.textContent='削除';
        li.append(edit,remove); list.append(li);
      });
    });
  }
  function grading(host, id, label) {
    if (host.querySelector(':scope > [data-cr-pid]')) return;
    const box = document.createElement('div'); box.className = 'cr-panel cr-grade'; box.dataset.crPid = prefix + id;
    const controls = document.createElement('div'); controls.className='cr-controls'; box.append(controls);
    for (const result of ['o','t','x']) {
      const button = document.createElement('button'); button.type='button'; button.textContent=labels[result]; button.className='cr-mark';button.setAttribute('aria-label',label+'を'+labels[result]+'で記録');
      button.onclick = event => { event.stopPropagation(); try { store.put(box.dataset.crPid,{ d:today(),r:result }); render(); } catch (_) { status.textContent='記録できませんでした。ブラウザの保存設定を確認してください。'; } };
      controls.append(button);
    }
    const details = document.createElement('details'); details.className='cr-history'; details.innerHTML='<summary>やった記録</summary><ul></ul>'; box.append(details);
    box.addEventListener('click',event => event.stopPropagation()); host.append(box);
  }
  function attach() {
    if (index) return;
    const questions = document.querySelectorAll('.q');
    if (questions.length) {
      const round = document.getElementById('roundSel')?.value || '1';
      questions.forEach((q,i) => grading(q,'r'+round+'-'+(q.id || 'q'+(i+1)), '第'+round+'回 問題'+(i+1)));
    } else if (!panel.querySelector('[data-cr-pid]')) {
      const chooser = document.createElement('input'); chooser.type='text'; chooser.value='1'; chooser.setAttribute('aria-label','記録する問題番号');
      const hint=document.createElement('p');hint.textContent='問題番号・小問番号を入力して採点します（例：1、1(2)）。';panel.append(hint,chooser);
      const host=document.createElement('div');panel.append(host);
      const change=()=>{host.replaceChildren();grading(host,chooser.value.trim() || '1','問題 '+(chooser.value.trim() || '1'));render();};
      chooser.onchange=change;change();
    }
    render();
  }
  store = SapixRecordSync.create({namespace:'calculation-test',returnTo:'calculation-test',onChange:render,onStatus:s=>{
    cloud=s;status.textContent=s.error || (s.syncing?'同期中…':s.connected?(s.pending?'端末に保存済み・未同期 '+s.pending+' 件':'Google接続済み・記録を同期'):'この端末に保存中');
    panel.querySelector('.cr-sync').disabled=!!(s.syncing || s.blocked);
  }});
  store.load(); attach();
  panel.querySelector('.cr-sync').onclick=async()=>{try{
    if(cloud.connected&&!cloud.needsAuth) await store.sync();
    else { if(!index) sessionStorage.setItem('calculation-return',location.pathname); await store.connect(); }
  }catch(_){status.textContent='Google接続を開始できませんでした。通信と保存設定を確認してください。';}};
  const callback=/sapix_(code|state|error)=/.test(location.hash);
  store.finishAuth().then(ok=>{
    if(index && callback && ok){ const dest=sessionStorage.getItem('calculation-return');sessionStorage.removeItem('calculation-return');
      if(dest && dest.startsWith('/math-app/calculation-test/') && !dest.includes('..') && dest.endsWith('.html')) location.assign(dest);
    } else store.sync();
  });
  let pending=false;
  new MutationObserver(mutations=>{if(!pending && mutations.some(m=>[...m.addedNodes].some(n=>n.nodeType===1 && (n.matches('.q') || n.querySelector('.q'))))){pending=true;queueMicrotask(()=>{pending=false;attach();});}}).observe(document.body,{childList:true,subtree:true});
  window.addEventListener('online',()=>store.sync());window.addEventListener('focus',()=>store.sync());
})();
