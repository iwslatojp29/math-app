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
      :host{font-family:-apple-system,"Hiragino Sans","Yu Gothic",sans-serif;color:#203d42;font-size:17px;line-height:1.7}*{box-sizing:border-box}[hidden]{display:none!important}button,select{font:inherit;min-height:44px;border:1px solid #b4cecb;border-radius:8px;background:white;color:#203d42;padding:7px 12px;max-width:100%}button{cursor:pointer}button:disabled{opacity:.4;cursor:default}button:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid #d89128;outline-offset:2px}.shell{position:fixed;inset:0;z-index:2147482000;display:flex;flex-direction:column;background:#f3f8f7;overflow:auto}.top{display:flex;align-items:center;gap:10px;padding:9px 16px;border-bottom:1px solid #c8dcda;background:white;flex-wrap:wrap}.top strong{flex:1;min-width:160px;font-size:14px}.tools{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:10px 16px;background:#e6f1ee;border-bottom:1px solid #c8dcda}.tools label{display:flex;align-items:center;gap:5px;font-size:12px}.tools select{font-size:14px;padding:5px 8px}.questions{max-width:min(430px,100%)}.sub{max-width:220px}.body{flex:1;display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);min-height:260px;gap:16px;padding:16px;overflow:auto}.picture{background:white;border:1px solid #ccdedb;border-radius:12px;display:flex;flex-direction:column;min-width:0;overflow:auto}.picture-head{font-size:12px;padding:8px 14px;border-bottom:1px solid #d8e5e2;color:#526c6d}.canvas{flex:1;min-height:0;display:block;padding:14px;overflow:auto}.notes{font-size:var(--lecture-size,19px);line-height:1.85;background:white;border:1px solid #ccdedb;border-radius:12px;padding:18px;overflow:auto;min-width:0;overflow-wrap:anywhere}.notes h2{font-size:1.05em;margin:0 0 14px}.caption{white-space:pre-wrap}.equation{white-space:pre-wrap;font-size:.95em;padding:12px;background:#eaf4f0;border-left:4px solid #278579;border-radius:6px}.position{font-size:12px;color:#567371}.transport{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:12px 16px;background:white;border-top:1px solid #c8dcda}.primary{background:#237d74;color:white;border-color:#237d74;min-width:115px}.position{margin-left:auto}.range{width:100%;height:6px;accent-color:#237d74}.status{font-size:12px;min-height:22px;margin:0;padding:0 16px 8px;background:white;color:#526e70}.transcript{padding:10px 18px;background:white;border-top:1px solid #d0e0db;font-size:14px}.transcript summary{cursor:pointer;min-height:42px;padding-top:7px}.transcript-content{max-height:50vh;overflow:auto}.transcript-content li{margin:12px 0}.credit{font-size:10px;color:#647b7c;text-align:right;margin:0;padding:5px 16px;background:white}.step-select{max-width:100%;width:100%;font-size:14px;margin-bottom:16px}.font{font-size:13px}.settings{display:flex;gap:8px;align-items:center;flex-wrap:wrap}audio{display:none}
      @media(max-width:850px){.body{grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);padding:10px;gap:10px}.notes{padding:13px}.top strong{display:none}}
      @media(max-width:650px){.body{display:flex;flex-direction:column;overflow:auto;min-height:0;flex:1}.picture{min-height:290px;flex:0 0 auto}.canvas{min-height:230px;max-height:58vh}.notes{overflow:visible;flex:0 0 auto}.tools{padding:7px 10px}.tools label{width:100%}.questions,.sub{max-width:100%;width:100%}.transport{gap:5px;padding:8px}.transport button{font-size:13px;padding:6px 9px}.settings{width:100%}.top{padding:7px 9px;gap:5px}.top button{font-size:13px}.position{font-size:11px}.transcript{font-size:13px}}
      @media print{.shell{display:none!important}}
    </style>
    <section class="shell" hidden role="dialog" aria-modal="true" aria-label="音声と図で学ぶ講義">
      <div class="top"><button type="button" class="normal">← 通常解説に戻る</button><strong></strong><label class="font">文字 <select aria-label="講義の文字サイズ"><option value="17">小</option><option value="19" selected>標準</option><option value="23">大</option></select></label><button type="button" class="print">印刷</button></div>
      <div class="tools"><label>問題 <select class="questions" aria-label="講義の問題"></select></label><label>小問・解法 <select class="sub" aria-label="講義の小問・解法"></select></label></div>
      <div class="body"><div class="picture"><div class="picture-head">いま見る数量・線・区間を強調します。 <select class="zoom" aria-label="講義の図の拡大率"><option value="1">図100%</option><option value="1.25">図125%</option><option value="1.5">図150%</option><option value="1.75">図175%</option><option value="2">図200%</option></select></div><div class="canvas" aria-label="講義の図"></div></div><div class="notes"><details class="conditions"><summary>問題の条件を確認</summary><p></p></details><select class="step-select" aria-label="講義の説明を選ぶ"></select><h2></h2><p class="caption"></p><p class="equation" hidden></p><div class="facts" hidden><strong>ここまでに分かったこと</strong><ul></ul></div><p class="checkpoint" hidden></p></div></div>
      <div class="transport"><button class="previous" type="button">← 前へ</button><button class="play primary" type="button">▶ 再生</button><button class="next" type="button">次へ →</button><button class="repeat" type="button">繰り返し</button><span class="position"></span><div class="settings"><label>速度 <select class="speed" aria-label="講義の再生速度"></select></label><button class="voice" type="button" aria-pressed="true">音声ON</button><button class="continuous" type="button" aria-pressed="true">連続ON</button></div><progress class="range" aria-label="講義の進み具合" max="1" value="0"></progress></div>
      <p class="status" role="status"></p><details class="transcript"><summary>全講義の書き起こしを読む</summary><div class="transcript-content"></div></details><p class="credit">音声：VOICEVOX:四国めたん ／ オフラインでも再生できます。</p>
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
    let lastUnit = null, question = data.questions[0], frame = 0, opened = false, opener = null, siblings = [], previousOverflow = '', motions=[];
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
        lastUnit=u.id; diagram.innerHTML='<style>'+data.svgStyle+'\n:host{display:block;width:100%}svg{display:block!important;width:100%!important;height:100%!important;max-height:100%!important;margin:auto}svg text{font-family:"Hiragino Sans","Yu Gothic",sans-serif}.recorded-focus{filter:drop-shadow(0 0 3px #de9623)}text.recorded-focus{font-weight:800;paint-order:stroke;stroke:#fff1c9;stroke-width:3px}table{width:100%;border-collapse:collapse;font-size:17px}th,td{padding:8px;border:1px solid #c5d8d4}.equation{font-size:23px;padding:20px;background:#f1f8f5}#reader-content{box-sizing:border-box!important;padding:0!important;display:block!important;height:calc(100% * var(--diagram-zoom,1))!important;width:calc(100% * var(--diagram-zoom,1))!important;overflow:visible!important;font-size:18px}.lecture{margin:0!important;border:0!important;background:white!important}.lz{transition:none!important}.recorded-pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));height:100%;gap:10px}@media(max-width:850px){.recorded-pair{grid-template-columns:1fr;height:auto}.recorded-pair svg{height:auto!important;min-height:260px}}</style><div class="lecture '+(data.diagramContext||'')+'" id="reader-content">'+u.svg+'</div>';
        buildMotions(u);$('.facts').hidden=!(u.facts?.length);$('.facts ul').replaceChildren(...(u.facts||[]).map(fact=>{const li=document.createElement('li');li.textContent=fact;return li;}));$('.checkpoint').textContent=u.checkpoint||'';$('.checkpoint').hidden=!u.checkpoint;$('.notes h2').textContent=u.title;$('.caption').textContent=u.displayText;$('.equation').textContent=u.equation;$('.equation').hidden=!u.equation;$('.step-select').value=String(clock.position);$('.notes').scrollTop=0;requestAnimationFrame(fitLabels);
      }
      $('.play').textContent=clock.playing?'Ⅱ 一時停止':clock.finished?'もう一度':clock.boundary?'次を聞く':'▶ 再生';$('.play').setAttribute('aria-pressed',String(clock.playing));
      $('.previous').disabled=clock.position===0;$('.next').disabled=clock.position===clock.sequence.length-1;
      $('.position').textContent='説明 '+(clock.position+1)+' / '+clock.sequence.length;
      $('.status').textContent=clock.message || (clock.playing?'再生中 · '+media.playbackRate.toFixed(2)+'倍':'停止した位置から再開できます。');
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
      $('.shell').hidden=false;$('.normal').focus();requestAnimationFrame(fitLabels);
    }
    function close() {
      clock.pause();opened=false;$('.shell').hidden=true;document.body.style.overflow=previousOverflow;siblings.forEach(([el,value])=>el.inert=value);siblings=[];
      updateLocation('');
      const link=[...document.querySelectorAll('nav a,aside a')].find(a=>a.getAttribute('href')==='#'+question.id);
      leaving=true;if(link)link.click();else document.querySelector('[data-lesson="'+question.id+'"]')?.click();if(data.legacyLectureOnly)document.querySelector('#review-toggle')?.click();leaving=false;opener?.focus?.({preventScroll:true});
    }
    options($('.questions'),data.questions.map(q=>[q.id,q.label+'｜'+q.title]));
    options($('.speed'),Array.from({length:9},(_,i)=>[1+i*.25,(1+i*.25).toFixed(2)+'倍']));
    $('.top strong').textContent=data.title;
    $('.questions').onchange=()=>choose($('.questions').value);$('.sub').onchange=()=>sequence($('.sub').value);
    $('.step-select').onchange=()=>{const resume=clock.playing;lastUnit=null;clock.select(clock.sequence,Number($('.step-select').value));if(resume)clock.play();};
    $('.play').onclick=()=>clock.playing?clock.pause():clock.play();$('.previous').onclick=()=>clock.move(-1);$('.next').onclick=()=>clock.move(1);$('.repeat').onclick=()=>clock.repeat();
    $('.speed').onchange=()=>clock.speed(Number($('.speed').value));$('.voice').onclick=()=>{media.muted=!media.muted;$('.voice').textContent=media.muted?'音声OFF':'音声ON';$('.voice').setAttribute('aria-pressed',String(!media.muted));};
    $('.continuous').onclick=()=>{clock.continuous=!clock.continuous;$('.continuous').textContent=clock.continuous?'連続ON':'連続OFF';$('.continuous').setAttribute('aria-pressed',String(clock.continuous));};
    $('.zoom').onchange=()=>{$('.canvas').style.setProperty('--diagram-zoom',$('.zoom').value);requestAnimationFrame(fitLabels);};window.addEventListener('resize',fitLabels);
    $('.font select').onchange=()=>host.style.setProperty('--lecture-size',$('.font select').value+'px');$('.normal').onclick=close;$('.print').onclick=()=>window.print();
    for(const q of data.questions){const section=document.createElement('section'),heading=document.createElement('h3');heading.textContent=q.label+'｜'+q.title;section.append(heading);const list=document.createElement('ol');for(const i of q.units){const u=data.units[i],li=document.createElement('li'),title=document.createElement('strong'),text=document.createElement('p');title.textContent=u.title;text.textContent=u.displayText;li.append(title,text);if(u.equation){const eq=document.createElement('p');eq.textContent=u.equation;li.append(eq);}list.append(li);}section.append(list);$('.transcript-content').append(section);}
    const launch=document.createElement('button');launch.type='button';launch.textContent='音声と図で講義';launch.id='recorded-lecture-launch';launch.style.cssText='font:inherit;min-height:44px;padding:7px 12px;border:1px solid #9bbfba;border-radius:7px;background:#237d74;color:white;cursor:pointer;margin:5px';launch.onclick=()=>open(launch);
    const anchor=document.querySelector('#mode-lecture,#lectureBtn,#lectureMode,#mode')||document.querySelector('.reader-topbar,.toolbar,header');if(anchor?.tagName==='BUTTON'){anchor.textContent='音声と図で講義';}else if(anchor)anchor.prepend(launch);else document.body.prepend(launch);
    const legacy='#mode-lecture,#lectureBtn,#lectureMode,#mode,#play,#repeat,#restart,#playButton,#bPlay';
    document.addEventListener('click',event=>{const button=event.target.closest?.('button,a');if(leaving||!button||button===launch)return;const label=button.textContent.trim();if(button.matches(legacy)||button.closest('.lecture')||(data.legacyLectureOnly&&button.matches('.nav-button'))||/講義|アニメーションあり/.test(label)){event.preventDefault();event.stopImmediatePropagation();open(button);}},true);
    document.addEventListener('visibilitychange',()=>{if(document.hidden)clock.pause();});window.addEventListener('pagehide',()=>clock.pause());
    window.addEventListener('math-tutor-question',()=>clock.pause());
    window.addEventListener('beforeprint',()=>clock.pause());document.addEventListener('keydown',e=>{if(e.key==='Escape'&&opened)close();});
    ui.addEventListener('keydown',event=>{event.stopPropagation();if(event.key==='Escape'){close();return;}if(event.key!=='Tab')return;const controls=[...ui.querySelectorAll('button,select,summary')].filter(x=>!x.disabled&&x.getClientRects().length);const first=controls[0],last=controls.at(-1);if(event.shiftKey&&ui.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&ui.activeElement===last){event.preventDefault();first.focus();}});
    choose(question.id);const requested=new URLSearchParams(location.search).get('lecture');if(data.questions.some(q=>q.id===requested))open(null,requested);
  }
  return { Clock, EPSILON, motionMatrix, mount };
});
