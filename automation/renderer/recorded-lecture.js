(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { window.RecordedLecture = api; api.mount(); }
})(function () {
  'use strict';
  const EPSILON = 0.025;
  function motionMatrix(m, progress) {
    if (m.type==='rotate') {
      const angle=((m.from||0)+((m.to||0)-(m.from||0))*progress)*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle),x=m.cx||0,y=m.cy||0;
      return [c,s,-s,c,x-c*x+s*y,y-s*x-c*y];
    }
    const angle=Math.atan2(m.y2-m.y1,m.x2-m.x1),c=Math.cos(angle),s=Math.sin(angle),f=Math.cos(Math.PI*progress),a=c*c+f*s*s,b=(1-f)*c*s,d=s*s+f*c*c;
    return [a,b,b,d,m.x1-a*m.x1-b*m.y1,m.y1-b*m.x1-d*m.y1];
  }
  class Clock {
    constructor(media, units, notify = () => {}) {
      this.media = media; this.units = units; this.notify = notify;
      this.sequence = []; this.position = 0; this.playing = false; this.continuous = true;
      this.finished = false; this.boundary = false; this.generation = 0; this.pendingSeek = null; this.message = '';
      media.preservesPitch = true; media.webkitPreservesPitch = true;
      media.addEventListener('loadedmetadata', () => {
        if (media.readyState >= 1 && this.pendingSeek !== null) { media.currentTime = this.pendingSeek; this.pendingSeek = null; }
        this.notify(this);
      });
      media.addEventListener('timeupdate', () => this.tick());
      media.addEventListener('ended', () => { if (!media.ended) return; this.pause(); this.finished = true; this.message = 'この講義は終わりです。'; this.notify(this); });
      media.addEventListener('error', () => { this.pause(); this.message = '音声を読み込めません。「前へ」「次へ」で図・字幕・書き起こしを読めます。'; this.notify(this); });
      media.addEventListener('play', () => { if (!this.playing) media.pause(); });
    }
    get unit() { return this.units[this.sequence[this.position]]; }
    pause() { this.generation++; this.playing = false; this.media.pause(); this.notify(this); }
    select(sequence, position = 0) {
      this.pause(); this.sequence = sequence.slice(); this.position = Math.max(0, Math.min(position, sequence.length - 1));
      this.finished = false; this.boundary = false; this.message = '';
      this.seek(this.unit.start); this.notify(this);
    }
    seek(time) {
      this.pendingSeek = time;
      if (this.media.readyState >= 1) { this.media.currentTime = time; this.pendingSeek = null; }
    }
    async play() {
      if (!this.unit) return;
      if (this.finished) this.select(this.sequence, 0);
      else if (this.boundary) this.move(1, false);
      this.playing = true; this.message = '音声を準備しています…'; const generation = ++this.generation; this.notify(this);
      try {
        await this.media.play();
        if (generation !== this.generation) return;
        this.message = ''; this.notify(this);
      } catch {
        if (generation !== this.generation) return;
        this.playing = false; this.message = '再生を開始できませんでした。もう一度「再生」を押してください。図と字幕は手動で読めます。'; this.notify(this);
      }
    }
    move(delta, autoplay = this.playing) {
      const target = this.position + delta;
      if (target < 0 || target >= this.sequence.length) return;
      this.select(this.sequence, target); if (autoplay) this.play();
    }
    repeat() { this.select(this.sequence, this.position); return this.play(); }
    speed(rate) { this.media.playbackRate = rate; this.media.preservesPitch = true; this.media.webkitPreservesPitch = true; this.notify(this); }
    tick() {
      if (!this.playing || this.pendingSeek !== null || !this.unit) return;
      if (this.media.currentTime < this.unit.end - EPSILON) return;
      if (this.position + 1 >= this.sequence.length) {
        this.pause(); this.finished = true; this.message = 'この講義は終わりです。'; this.notify(this); return;
      }
      if (!this.continuous) {
        this.pause(); this.boundary = true; this.message = 'ここで一息。「次を聞く」で次の説明へ進めます。'; this.notify(this); return;
      }
      const previous = this.unit; this.position++;
      if (Math.abs(this.unit.start - previous.end) > EPSILON) this.seek(this.unit.start);
      this.notify(this);
    }
  }

  function mount() {
    const node = document.getElementById('recorded-lecture-data');
    if (!node || document.getElementById('recorded-lecture-host')) return;
    const data = JSON.parse(node.textContent), host = document.createElement('div'); host.id = 'recorded-lecture-host';
    const ui = host.attachShadow({ mode: 'open' });
    ui.innerHTML = `<style>
      :host{font-family:-apple-system,"Hiragino Sans","Yu Gothic",sans-serif;color:#203d42;font-size:17px;line-height:1.6}
      *{box-sizing:border-box}[hidden]{display:none!important}button,select,summary{font:inherit;touch-action:manipulation}
      button,select{min-height:44px;border:1px solid #bfd3cf;border-radius:8px;background:white;color:#203d42;padding:5px 10px;max-width:100%}
      button,summary{cursor:pointer}button:disabled{opacity:.4;cursor:default}button:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid #d89128;outline-offset:2px}
      .shell{position:fixed;inset:0;z-index:2147482000;display:flex;flex-direction:column;background:#eef4f2;overflow:hidden}
      .top{position:relative;display:flex;align-items:center;gap:8px;flex:none;padding:6px 10px 9px;background:white;border-bottom:1px solid #c8dcda;z-index:4}
      .top>strong{flex:1;min-width:0;font-size:13px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
      .normal{font-size:13px}.transport{display:flex;gap:6px;align-items:center;flex:none}.transport button{font-size:14px;white-space:nowrap}
      .primary{background:#237d74;color:white;border-color:#237d74;min-width:100px}.range{position:absolute;left:0;bottom:0;width:100%;height:3px;border:0;accent-color:#237d74}
      .settings-menu{position:relative;flex:none}.settings-menu>summary{list-style:none;min-height:44px;padding:10px;font-size:13px;border:1px solid #bfd3cf;border-radius:8px}.settings-menu>summary::-webkit-details-marker{display:none}
      .settings{position:absolute;right:0;top:calc(100% + 6px);width:290px;padding:16px;display:grid;grid-template-columns:1fr 1fr;gap:12px;background:white;border:1px solid #b9d1ca;border-radius:12px;box-shadow:0 8px 30px #203d4229}
      .settings label{font-size:12px;display:flex;flex-direction:column;gap:4px}.settings button,.settings select{width:100%;font-size:14px}.info-open{font-size:13px;white-space:nowrap}
      .workspace{flex:1;min-height:0;display:grid;grid-template-columns:156px minmax(0,1fr)}
      .question-sidebar{min-height:0;background:#f9fbfa;border-right:1px solid #c8dcda;display:flex;flex-direction:column;overflow:hidden}.question-sidebar h2{font-size:13px;margin:0;padding:13px 12px 9px;color:#4c6a63}
      .question-list{overflow-y:auto;overscroll-behavior:contain;padding:0 6px 8px;min-height:0}.question-list h3{font-size:11px;color:#5b756d;margin:14px 6px 5px}.question-list button{display:block;width:100%;text-align:left;border-color:transparent;border-radius:7px;padding:8px;margin:3px 0;background:transparent;line-height:1.4}
      .question-list button strong{display:block;font-size:14px}.question-list button small{display:block;font-size:11px;color:#526e66;margin-top:3px;overflow-wrap:anywhere}.question-list button[aria-current="true"]{background:#dceee7;border-color:#83b5a4;color:#145c48;box-shadow:inset 3px 0 #237d74}
      .questions{display:none}.lesson{min-width:0;min-height:0;display:flex;flex-direction:column}.tools{flex:none;display:flex;gap:8px;align-items:center;padding:6px 10px;background:#e3eeea;border-bottom:1px solid #c8dcda}
      .tools label{display:flex;gap:5px;align-items:center;font-size:12px;flex:none}.sub{max-width:170px;font-size:13px}.table-view{max-width:190px}.table-select{min-width:0;width:100%;font-size:12px}.step-select{min-width:0;flex:1;font-size:13px}.position{font-size:12px;white-space:nowrap;color:#526e66}
      .body{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1.4fr) minmax(280px,1fr);gap:10px;padding:10px}
      .picture{min-width:0;min-height:0;border:1px solid #ccdedb;border-radius:10px;background:white;overflow:hidden;display:flex;flex-direction:column}.canvas{flex:1;min-height:0;padding:10px;overflow:auto;display:block}
      .notes{min-width:0;min-height:0;overflow:auto;overflow-wrap:anywhere;background:white;border:1px solid #ccdedb;border-radius:10px;padding:18px;font-size:var(--fitted-size,var(--lecture-size,19px));line-height:1.65}
      .notes h2{font-size:1.04em;line-height:1.45;margin:0 0 16px}.caption{white-space:pre-wrap;margin:0}.equation{white-space:pre-wrap;font-size:1em;line-height:1.5;margin:16px 0 0;padding:12px;background:#eaf4f0;border-left:4px solid #278579;border-radius:6px}.checkpoint{font-size:.95em;margin:14px 0 0}
      .status{position:absolute;left:50%;top:calc(100% + 8px);transform:translateX(-50%);width:max-content;max-width:min(560px,95vw);padding:8px 14px;margin:0;font-size:13px;color:#203d42;background:#fff5dc;border:1px solid #e6ca84;border-radius:8px;box-shadow:0 3px 16px #203d4220}
      .resource-panel{position:absolute;inset:70px 14px 14px auto;width:min(680px,calc(100% - 28px));z-index:5;background:white;box-shadow:0 10px 70px #203d4240;border:1px solid #bdd4cb;border-radius:12px;padding:20px;overflow:auto;font-size:16px}.resource-panel header{display:flex;align-items:center;justify-content:space-between;gap:12px}.resource-panel h2{font-size:19px;margin:0}.resource-panel summary{padding:12px 0;min-height:44px;font-weight:700}.resource-panel p{white-space:pre-wrap}.transcript-content li{margin:14px 0}.credit{font-size:11px;color:#647b7c;border-top:1px solid #d5e2dd;padding-top:14px}
      audio{display:none}
      @media(max-width:1100px){.top>strong{display:none}.top{justify-content:space-between}.workspace{grid-template-columns:140px minmax(0,1fr)}.body{grid-template-columns:minmax(0,1.25fr) minmax(280px,1fr);padding:8px;gap:8px}.notes{padding:16px}}
      @media(max-width:850px){.workspace{grid-template-columns:108px minmax(0,1fr)}.question-list button{padding:7px 5px}.question-list button small{font-size:10px}.body{grid-template-columns:minmax(0,1.05fr) minmax(260px,1fr);gap:6px;padding:6px}.notes{padding:13px}.canvas{padding:6px}.top{gap:5px;padding:5px 6px 8px}.transport{gap:4px}.transport button{padding:5px 8px}.primary{min-width:90px}.tools{gap:5px;padding:5px 6px}.sub{max-width:120px}.info-open{padding:5px 8px}.position{font-size:11px}}
      @media(max-width:650px){.top{flex-wrap:wrap;justify-content:flex-start}.normal{margin-right:auto}.transport{order:2;width:100%}.transport button{flex:1}.workspace{grid-template-columns:88px minmax(0,1fr)}.question-sidebar h2{font-size:11px;padding:10px 6px}.question-list{padding:0 3px}.question-list button strong{font-size:12px}.question-list button small{font-size:10px}.tools{flex-wrap:wrap}.tools label{flex:1}.sub{max-width:100%;width:100%}.step-select{flex-basis:100%;order:2}.body{display:flex;flex-direction:column;overflow:auto}.picture{min-height:280px;flex:none}.canvas{height:280px;flex:none}.notes{min-height:240px;flex:none;overflow:visible}.position{margin-left:auto}.resource-panel{inset:112px 8px 8px;width:calc(100% - 16px);padding:14px}}
      @media print{.shell{display:none!important}}
    </style>
    <section class="shell" hidden role="dialog" aria-modal="true" aria-label="音声と図で学ぶ講義">
      <header class="top"><button type="button" class="normal">← 通常解説</button><strong></strong>
        <div class="transport" aria-label="講義の再生操作"><button class="previous" type="button">← 前へ</button><button class="play primary" type="button">▶ 再生</button><button class="next" type="button">次へ →</button><button class="repeat" type="button">繰り返し</button></div>
        <details class="settings-menu"><summary>再生・表示設定</summary><div class="settings"><label>速度 <select class="speed" aria-label="講義の再生速度"></select></label><label class="font">文字 <select aria-label="講義の文字サイズ"><option value="17">小</option><option value="19" selected>標準</option><option value="23">大</option></select></label><button class="voice" type="button" aria-pressed="true">音声ON</button><button class="continuous" type="button" aria-pressed="true">連続ON</button><label>図の大きさ <select class="zoom" aria-label="講義の図の拡大率"><option value="1">画面に合わせる</option><option value="1.25">125%</option><option value="1.5">150%</option><option value="1.75">175%</option><option value="2">200%</option></select></label><button type="button" class="print">印刷</button></div></details>
        <button type="button" class="info-open" aria-expanded="false">条件・全文</button><progress class="range" aria-label="講義の進み具合" max="1" value="0"></progress><p class="status" role="status" hidden></p>
      </header>
      <div class="workspace"><aside class="question-sidebar" aria-label="講義の問題一覧"><h2>問題を選ぶ</h2><nav class="question-list" aria-label="問題一覧"></nav><select class="questions" aria-label="講義の問題" tabindex="-1"></select></aside>
        <main class="lesson"><div class="tools"><label>小問・解法 <select class="sub" aria-label="講義の小問・解法"></select></label><select class="step-select" aria-label="講義の説明を選ぶ"></select><label class="table-view" hidden>表 <select class="table-select" aria-label="図の表の表示範囲"></select></label><span class="position"></span></div>
          <div class="body"><section class="picture"><div class="canvas" aria-label="講義の図"></div></section><article class="notes"><h2></h2><p class="caption"></p><p class="equation" hidden></p><p class="checkpoint" hidden></p></article></div>
        </main>
      </div>
      <aside class="resource-panel" hidden aria-label="問題の条件と書き起こし"><header><h2>問題の条件・講義の全文</h2><button type="button" class="info-close">閉じる</button></header><details class="conditions" open><summary>問題の条件を確認</summary><p></p></details><div class="facts" hidden><strong>ここまでに分かったこと</strong><ul></ul></div><details class="table-complete" hidden><summary>表の全行を読む</summary><div></div></details><details class="transcript"><summary>全講義の書き起こしを読む</summary><div class="transcript-content"></div></details><p class="credit">音声：VOICEVOX:四国めたん ／ オフラインでも再生できます。</p></aside>
    </section>`;
    document.body.append(host); const $ = selector => ui.querySelector(selector);
    const diagram = $('.canvas').attachShadow({ mode: 'open' });
    const media = document.createElement('audio'); media.id = 'recorded-lecture-audio'; media.preload = 'metadata'; media.setAttribute('playsinline', ''); ui.append(media);
    // Keep large embedded recordings out of the live DOM after reading them.
    // The delivered HTML still contains every source, and playback stays local.
    const audioSources=new Map(),audioPrefix='recorded-lecture-audio-source--';
    for(const source of document.querySelectorAll('script[id^="'+audioPrefix+'"]')){
      audioSources.set(source.id.slice(audioPrefix.length),source.textContent.trim());source.remove();
    }
    let audioQuestion = '';
    let leaving = false;
    let lastUnit = null, question = data.questions[0], frame = 0, opened = false, opener = null, siblings = [], previousOverflow = '', motions=[], largeTable=null;
    const labelLayouts=new WeakMap();
    const options = (select, entries) => { select.replaceChildren(...entries.map(([value,label]) => { const o=document.createElement('option');o.value=String(value);o.textContent=label;return o; })); };
    function fitLabels() {
      for (const text of diagram.querySelectorAll('svg text')) {
        const scale = Math.hypot(text.getScreenCTM()?.a || 0, text.getScreenCTM()?.b || 0);
        if (!text.dataset.recordedFont) text.dataset.recordedFont = String(Number.parseFloat(text.getAttribute('font-size')||window.getComputedStyle(text).fontSize)||20);
        const size=scale>0?Math.max(Number(text.dataset.recordedFont),14/scale):Number(text.dataset.recordedFont);
        if (scale > 0) {text.setAttribute('font-size', String(size));text.style.fontSize=size+'px';}
        const label=text.textContent,colon=label.indexOf('：'),y=Number(text.getAttribute('y'));
        const anchor=text.getAttribute('text-anchor')||window.getComputedStyle(text).textAnchor;
        if(!text.children.length&&label.length>20&&colon>0&&y>=20&&y<35&&anchor==='middle'){
          text.dataset.recordedTitleY=String(y);
          const lines=[label.slice(0,colon+1),label.slice(colon+1)];
          text.replaceChildren(...lines.map(line=>{const span=document.createElementNS('http://www.w3.org/2000/svg','tspan');span.textContent=line;return span;}));
        }
        if(text.dataset.recordedTitleY!==undefined){
          const spans=text.children;spans[0].setAttribute('x',text.getAttribute('x'));spans[0].setAttribute('y',String(Number(text.dataset.recordedTitleY)-size*.55));
          spans[1].setAttribute('x',text.getAttribute('x'));spans[1].setAttribute('dy',String(size*1.15));
        }
      }
    }
    function prepareTable() {
      largeTable=null;$('.table-view').hidden=true;$('.table-complete').hidden=true;
      const table=diagram.querySelector('table'),rows=table?[...table.querySelectorAll('tbody tr')]:[];
      if(rows.length<=24)return;
      const full=table.cloneNode(true);$('.table-complete div').replaceChildren(full);$('.table-complete').hidden=false;
      const gap=document.createElement('tr'),cell=document.createElement('td');cell.colSpan=table.rows[0].cells.length;cell.textContent='… 中間の行は上の「表」で切り替え …';cell.style.cssText='text-align:center;color:#577369;font-size:13px;padding:10px';gap.append(cell);rows[4].before(gap);
      largeTable={table,rows,gap};
      options($('.table-select'),[['overview','先頭と末尾'],...Array.from({length:Math.ceil(rows.length/18)},(_,i)=>[String(i),(i*18+1)+'〜'+Math.min(rows.length,(i+1)*18)+'行 / '+rows.length])]);
      $('.table-view').hidden=false;$('.table-select').value='overview';showTable();
    }
    function showTable() {
      if(!largeTable)return;const {rows,gap}=largeTable,value=$('.table-select').value,overview=value==='overview',start=Number(value)*18;
      rows.forEach((row,i)=>row.hidden=overview?i>=4&&i<rows.length-4:i<start||i>=start+18);gap.hidden=!overview;
      requestAnimationFrame(fitScene);
    }
    function fitNotes() {
      if (!opened || window.innerWidth < 651) return;
      const notes=$('.notes'),preferred=Number($('.font select').value);
      let size=preferred;notes.style.setProperty('--fitted-size',size+'px');
      while(size>16 && notes.scrollHeight>notes.clientHeight+1){size-=.5;notes.style.setProperty('--fitted-size',size+'px');}
    }
    function fitScene() {
      for(const text of diagram.querySelectorAll('svg text')){
        const saved=labelLayouts.get(text);if(!saved)continue;text.innerHTML=saved.markup;
        if(saved.transform===null)text.removeAttribute('transform');else text.setAttribute('transform',saved.transform);
      }
      const pair=diagram.querySelector('.recorded-pair');
      if(pair){
        const figures=[...pair.querySelectorAll('svg')],box=pair.getBoundingClientRect();
        const sizes=figures.map(svg=>svg.viewBox.baseVal);
        if(sizes.length===2&&sizes.every(s=>s.width>0&&s.height>0)){
          const across=Math.min((box.width-10)/sizes.reduce((n,s)=>n+s.width,0),box.height/Math.max(...sizes.map(s=>s.height)));
          const down=Math.min(box.width/Math.max(...sizes.map(s=>s.width)),(box.height-10)/sizes.reduce((n,s)=>n+s.height,0));
          pair.classList.toggle('stacked',down>across);
        }
      }
      const reader=diagram.querySelector('#reader-content');
      for(const table of diagram.querySelectorAll('.text-scene table')){
        let size=20;table.style.fontSize=size+'px';table.style.removeProperty('--cell-wrap');
        while(size>14&&(table.getBoundingClientRect().width>reader.clientWidth+1||table.getBoundingClientRect().height>reader.clientHeight+1)){size-=.5;table.style.fontSize=size+'px';}
        if(table.getBoundingClientRect().width>reader.clientWidth+1)table.style.setProperty('--cell-wrap','normal');
      }
      fitLabels();
      if(window.innerWidth>850||$('.zoom').value!=='1'){fitNotes();return;}
      const canvasBox=$('.canvas').getBoundingClientRect(),limit=canvasBox.width-18;
      for(const text of diagram.querySelectorAll('svg text')){
        if(!labelLayouts.has(text))labelLayouts.set(text,{markup:text.innerHTML,transform:text.getAttribute('transform')});
        let box=text.getBoundingClientRect();if(!box.width||(box.left>=canvasBox.left-3&&box.right<=canvasBox.right+3))continue;
        if(!text.children.length&&box.width>limit&&text.textContent.length>12){
          const label=text.textContent,parts=label.match(/\d+(?:\.\d+)?[°%]?|[A-Za-z]+|[^\s]/g)||[label];
          let capacity=Math.max(8,Math.floor(label.length*limit/box.width)-1),lines=[];
          for(let trial=0;trial<5;trial++){
            lines=[''];for(const part of parts){if(lines.at(-1).length+part.length>capacity&&lines.at(-1))lines.push('');lines[lines.length-1]+=part;}
            const x=text.getAttribute('x')||'0',y=text.getAttribute('y')||'0',size=Number.parseFloat(text.style.fontSize)||20;
            text.replaceChildren(...lines.map((line,i)=>{const span=document.createElementNS('http://www.w3.org/2000/svg','tspan');span.textContent=line;span.setAttribute('x',x);if(!i)span.setAttribute('y',y);else span.setAttribute('dy',String(size*1.2));return span;}));
            box=text.getBoundingClientRect();if(box.width<=limit)break;capacity=Math.max(6,capacity-2);
          }
        }
        const dx=box.left<canvasBox.left+8?canvasBox.left+8-box.left:box.right>canvasBox.right-8?canvasBox.right-8-box.right:0;
        if(dx){const matrix=text.getScreenCTM(),inverse=matrix?.inverse?.(),scale=Math.hypot(matrix?.a||1,matrix?.b||0),localX=inverse?inverse.a*dx:dx/scale,localY=inverse?inverse.b*dx:0;text.setAttribute('transform',(labelLayouts.get(text).transform||'')+' translate('+localX+' '+localY+')');}
      }
      fitNotes();
    }
    if(window.ResizeObserver){const observer=new ResizeObserver(()=>requestAnimationFrame(fitScene));observer.observe($('.body'));}
    function buildMotions(unit) {
      motions=[];const svg=diagram.querySelector('svg');if(!svg)return;
      const ns='http://www.w3.org/2000/svg',make=(tag,attrs={})=>{const node=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))node.setAttribute(k,v);return node;};
      for(const m of unit.motions||[]) {
        const node=make('g',{'data-recorded-motion':m.type});svg.append(node);const entry={m,node};
        if(m.type==='trace'&&m.points?.length>1) {
          const path=make('polyline',{points:m.points.map(p=>p.join(',')).join(' '),fill:'none',stroke:m.color||'#bd6d21','stroke-width':4,pathLength:1,'stroke-dasharray':1});
          const dot=make('circle',{r:5,fill:m.color||'#bd6d21'});node.append(path,dot);entry.path=path;entry.dot=dot;
        } else node.innerHTML=m.svg||'';
        motions.push(entry);
      }
    }
    function updateMotions() {
      if(!clock?.unit)return;
      const elapsed=(!clock.playing&&media.currentTime<=clock.unit.start+EPSILON)?Infinity:Math.max(0,media.currentTime-clock.unit.start);
      const reduced=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      for(const {m,node,path,dot} of motions) {
        const p=reduced?1:Math.min(1,elapsed/((m.ms||2200)/1000));
        if(path) {
          path.setAttribute('stroke-dashoffset',String(1-p));let total=0;const lengths=[];
          for(let i=1;i<m.points.length;i++){const length=Math.hypot(m.points[i][0]-m.points[i-1][0],m.points[i][1]-m.points[i-1][1]);lengths.push(length);total+=length;}
          let distance=p*total,index=0;while(index<lengths.length-1&&distance>lengths[index])distance-=lengths[index++];
          const a=m.points[index],b=m.points[index+1],t=lengths[index]?distance/lengths[index]:1;
          dot.setAttribute('cx',String(a[0]+(b[0]-a[0])*t));dot.setAttribute('cy',String(a[1]+(b[1]-a[1])*t));
        } else node.setAttribute('transform','matrix('+motionMatrix(m,p).join(' ')+')');
      }
    }
    function render(clock) {
      if (!clock.unit) return;
      const u=clock.unit;
      if (lastUnit !== u.id) {
        lastUnit=u.id; diagram.innerHTML='<style>'+data.svgStyle+'\n:host{display:block;width:100%;height:100%}[hidden]{display:none!important}svg{display:block!important;width:100%!important;height:100%!important;max-height:100%!important;margin:auto}svg text{font-family:"Hiragino Sans","Yu Gothic",sans-serif}.recorded-focus{filter:drop-shadow(0 0 3px #de9623)}text.recorded-focus{font-weight:800;paint-order:stroke;stroke:#fff1c9;stroke-width:3px}table{width:100%;border-collapse:collapse;font-size:17px}th,td{padding:8px;border:1px solid #c5d8d4}.equation{font-size:23px;padding:20px;background:#f1f8f5}#reader-content{box-sizing:border-box!important;padding:0!important;display:flow-root!important;height:calc(100% * var(--diagram-zoom,1))!important;width:calc(100% * var(--diagram-zoom,1))!important;overflow:visible!important;font-size:18px}.lecture{margin:0!important;border:0!important;background:white!important}#reader-content>:first-child{margin-top:0!important}#reader-content>:last-child{margin-bottom:0!important}#reader-content.text-scene{display:grid!important;align-content:center;gap:16px}.text-scene>.equation{font-size:clamp(23px,3vw,36px);line-height:1.6;padding:20px;white-space:normal;overflow-wrap:anywhere;width:100%}.text-scene table{font-size:20px;table-layout:auto}.text-scene td,.text-scene th{white-space:var(--cell-wrap,nowrap);overflow-wrap:normal;padding:4px 5px;line-height:1.25}.lz{transition:none!important}.recorded-pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:minmax(0,1fr);height:100%;gap:10px}.recorded-pair.stacked{grid-template-columns:minmax(0,1fr);grid-template-rows:repeat(2,minmax(0,1fr))}.recorded-pair svg{min-height:0!important;min-width:0!important}</style><div class="lecture '+(data.diagramContext||'')+'" id="reader-content">'+u.svg+'</div>';
        prepareTable();
        diagram.querySelector('#reader-content').classList.toggle('text-scene',!diagram.querySelector('svg'));
        buildMotions(u);$('.facts').hidden=!(u.facts?.length);$('.facts ul').replaceChildren(...(u.facts||[]).map(fact=>{const li=document.createElement('li');li.textContent=fact;return li;}));$('.checkpoint').textContent=u.checkpoint||'';$('.checkpoint').hidden=!u.checkpoint;$('.notes h2').textContent=u.title;$('.caption').textContent=u.displayText;$('.equation').textContent=u.equation;$('.equation').hidden=!u.equation;$('.step-select').value=String(clock.position);$('.notes').scrollTop=0;requestAnimationFrame(fitScene);
      }
      $('.play').textContent=clock.playing?'Ⅱ 一時停止':clock.finished?'もう一度':clock.boundary?'次を聞く':'▶ 再生';$('.play').setAttribute('aria-pressed',String(clock.playing));
      $('.previous').disabled=clock.position===0;$('.next').disabled=clock.position===clock.sequence.length-1;
      $('.position').textContent=(clock.position+1)+' / '+clock.sequence.length;
      $('.range').value=(clock.position+Math.max(0,Math.min(1,(media.currentTime-clock.unit.start)/(clock.unit.end-clock.unit.start))))/clock.sequence.length;
      $('.status').textContent=clock.message;$('.status').hidden=!clock.message;
      updateMotions();
      if (clock.playing && !frame) frame=requestAnimationFrame(tick);
    }
    const clock=new Clock(media,data.units,render);
    function tick() {
      frame=0;clock.tick();updateMotions();
      if (clock.unit) $('.range').value=(clock.position+Math.max(0,Math.min(1,(media.currentTime-clock.unit.start)/(clock.unit.end-clock.unit.start))))/clock.sequence.length;
      if(clock.playing&&!frame)frame=requestAnimationFrame(tick);
    }
    function sequence(chapter='') {
      const found=question.chapters.find(c=>c.label===chapter);
      const seq=found?[...new Set([...question.units.filter(i=>data.units[i].stepIndex<0),...found.steps.flatMap(step=>question.units.filter(i=>data.units[i].stepIndex===step))])]:question.units;
      options($('.step-select'),seq.map((i,p)=>[p,(p+1)+'. '+data.units[i].title]));
      lastUnit=null;clock.select(seq.length?seq:question.units);
    }
    function updateLocation(id) {
      try {const url=new URL(location.href);if(id)url.searchParams.set('lecture',id);else url.searchParams.delete('lecture');history.replaceState(null,'',url);}
      catch { /* Local-file viewers may forbid changing the address. */ }
    }
    function choose(id, chapter='') {
      clock.pause();
      question=data.questions.find(q=>q.id===id)||data.questions[0];$('.questions').value=question.id;$('.conditions p').textContent=question.conditions||'';$('.conditions').hidden=!question.conditions;
      for(const button of ui.querySelectorAll('.question-list button'))button.setAttribute('aria-current',String(button.dataset.question===question.id));
      $('.question-list button[aria-current="true"]')?.scrollIntoView({block:'nearest',inline:'nearest'});
      if (audioQuestion !== question.id) {
        audioQuestion=question.id;media.src=audioSources.get(question.id);media.load();
      }
      options($('.sub'),[['','全体'],...question.chapters.map(c=>[c.label,c.label])]);$('.sub').value=chapter;sequence(chapter);
      if(opened)updateLocation(question.id);
    }
    function activeQuestion(target) {
      const card=target?.closest?.('article,[data-lecture]');
      const candidates=[target?.dataset?.lesson,target?.dataset?.pid,card?.id,card?.getAttribute('data-lecture'),decodeURIComponent(location.hash.slice(1)),document.querySelector('[aria-current="true"],[aria-current="location"],nav a.active')?.getAttribute('href')?.replace(/^#/,'')];
      return candidates.find(id=>data.questions.some(q=>q.id===id))||question.id;
    }
    function open(target, id='') {
      opener=target||document.activeElement;choose(id||activeQuestion(target));
      if(opened)return;
      opened=true;previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';
      updateLocation(question.id);
      siblings=[...document.body.children].filter(el=>el!==host&& !['SCRIPT','STYLE'].includes(el.tagName)).map(el=>[el,el.inert]);siblings.forEach(([el])=>el.inert=true);
      $('.shell').hidden=false;$('.normal').focus();requestAnimationFrame(fitScene);
    }
    function close() {
      clock.pause();opened=false;$('.resource-panel').hidden=true;$('.settings-menu').open=false;$('.info-open').setAttribute('aria-expanded','false');$('.shell').hidden=true;document.body.style.overflow=previousOverflow;siblings.forEach(([el,value])=>el.inert=value);siblings=[];
      updateLocation('');
      const link=[...document.querySelectorAll('nav a,aside a')].find(a=>a.getAttribute('href')==='#'+question.id);
      leaving=true;if(link)link.click();else document.querySelector('[data-lesson="'+question.id+'"]')?.click();if(data.legacyLectureOnly)document.querySelector('#review-toggle')?.click();leaving=false;opener?.focus?.({preventScroll:true});
    }
    options($('.questions'),data.questions.map(q=>[q.id,q.label+'｜'+q.title]));
    let previousGroup='';
    for(const q of data.questions){
      const original=[...document.querySelectorAll('nav a,aside a,nav button')].find(a=>a.getAttribute('href')==='#'+q.id||a.dataset.lesson===q.id);
      let current=original,group='';
      for(let depth=0;current&&depth<4&&!group;depth++,current=current.parentElement){
        let previous=current.previousElementSibling;
        while(previous){if(previous.matches('h2,h3,h4,strong,b,.nav-label,.nav-group-title,.group-label')){group=previous.textContent.trim();break;}previous=previous.previousElementSibling;}
      }
      if(group.length>24)group='';
      if(group&&group!==previousGroup){const heading=document.createElement('h3');heading.textContent=group;$('.question-list').append(heading);previousGroup=group;}
      const button=document.createElement('button'),label=document.createElement('strong'),title=document.createElement('small');button.type='button';button.dataset.question=q.id;
      const originalLabel=original?.textContent.trim();label.textContent=originalLabel&&originalLabel.length<18?originalLabel:q.label.replace(/^[a-z]+-?0*(\d+)$/,'$1');title.textContent=q.title;button.append(label,title);button.onclick=()=>choose(q.id);$('.question-list').append(button);
    }
    options($('.speed'),Array.from({length:9},(_,i)=>[1+i*.25,(1+i*.25).toFixed(2)+'倍']));
    $('.top strong').textContent=data.title;
    $('.questions').onchange=()=>choose($('.questions').value);$('.sub').onchange=()=>sequence($('.sub').value);
    $('.step-select').onchange=()=>{const resume=clock.playing;lastUnit=null;clock.select(clock.sequence,Number($('.step-select').value));if(resume)clock.play();};
    $('.play').onclick=()=>clock.playing?clock.pause():clock.play();$('.previous').onclick=()=>clock.move(-1);$('.next').onclick=()=>clock.move(1);$('.repeat').onclick=()=>clock.repeat();
    $('.speed').onchange=()=>clock.speed(Number($('.speed').value));$('.voice').onclick=()=>{media.muted=!media.muted;$('.voice').textContent=media.muted?'音声OFF':'音声ON';$('.voice').setAttribute('aria-pressed',String(!media.muted));};
    $('.continuous').onclick=()=>{clock.continuous=!clock.continuous;$('.continuous').textContent=clock.continuous?'連続ON':'連続OFF';$('.continuous').setAttribute('aria-pressed',String(clock.continuous));};
    $('.table-select').onchange=showTable;
    $('.zoom').onchange=()=>{$('.canvas').style.setProperty('--diagram-zoom',$('.zoom').value);requestAnimationFrame(fitScene);};window.addEventListener('resize',fitScene);
    $('.font select').onchange=()=>{host.style.setProperty('--lecture-size',$('.font select').value+'px');requestAnimationFrame(fitNotes);};$('.normal').onclick=close;$('.print').onclick=()=>window.print();
    const hideInfo=()=>{$('.resource-panel').hidden=true;$('.info-open').setAttribute('aria-expanded','false');$('.info-open').focus();};
    $('.info-open').onclick=()=>{if(!$('.resource-panel').hidden){hideInfo();return;}clock.pause();$('.settings-menu').open=false;$('.resource-panel').hidden=false;$('.info-open').setAttribute('aria-expanded','true');$('.info-close').focus();};$('.info-close').onclick=hideInfo;
    ui.addEventListener('click',event=>{if(!event.target.closest('.settings-menu'))$('.settings-menu').open=false;});
    for(const q of data.questions){const section=document.createElement('section'),heading=document.createElement('h3');heading.textContent=q.label+'｜'+q.title;section.append(heading);const list=document.createElement('ol');for(const i of q.units){const u=data.units[i],li=document.createElement('li'),title=document.createElement('strong'),text=document.createElement('p');title.textContent=u.title;text.textContent=u.displayText;li.append(title,text);if(u.equation){const eq=document.createElement('p');eq.textContent=u.equation;li.append(eq);}list.append(li);}section.append(list);$('.transcript-content').append(section);}
    const launch=document.createElement('button');launch.type='button';launch.textContent='音声と図で講義';launch.id='recorded-lecture-launch';launch.style.cssText='font:inherit;min-height:44px;padding:7px 12px;border:1px solid #9bbfba;border-radius:7px;background:#237d74;color:white;cursor:pointer;margin:5px';launch.onclick=()=>open(launch);
    const anchor=document.querySelector('#mode-lecture,#lectureBtn,#lectureMode,#mode')||document.querySelector('.reader-topbar,.toolbar,header');if(anchor?.tagName==='BUTTON'){anchor.textContent='音声と図で講義';}else if(anchor)anchor.prepend(launch);else document.body.prepend(launch);
    const legacy='#mode-lecture,#lectureBtn,#lectureMode,#mode,#play,#repeat,#restart,#playButton,#bPlay';
    document.addEventListener('click',event=>{const button=event.target.closest?.('button,a');if(leaving||!button||button===launch)return;const label=button.textContent.trim();if(button.matches(legacy)||button.closest('.lecture')||(data.legacyLectureOnly&&button.matches('.nav-button'))||/講義|アニメーションあり/.test(label)){event.preventDefault();event.stopImmediatePropagation();open(button);}},true);
    document.addEventListener('visibilitychange',()=>{if(document.hidden)clock.pause();});window.addEventListener('pagehide',()=>clock.pause());
    window.addEventListener('math-tutor-question',()=>clock.pause());
    window.addEventListener('beforeprint',()=>clock.pause());document.addEventListener('keydown',e=>{if(e.key==='Escape'&&opened)close();});
    ui.addEventListener('keydown',event=>{event.stopPropagation();if(event.key==='Escape'){if(!$('.resource-panel').hidden)hideInfo();else if($('.settings-menu').open)$('.settings-menu').open=false;else close();return;}if(event.key!=='Tab')return;const controls=[...ui.querySelectorAll('button,select,summary')].filter(x=>!x.disabled&&x.getClientRects().length);const first=controls[0],last=controls.at(-1);if(event.shiftKey&&ui.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&ui.activeElement===last){event.preventDefault();first.focus();}});
    choose(question.id);const requested=new URLSearchParams(location.search).get('lecture');if(data.questions.some(q=>q.id===requested))open(null,requested);
  }
  return { Clock, EPSILON, motionMatrix, mount };
});
