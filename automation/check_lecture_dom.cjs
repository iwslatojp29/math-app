// DOM/event regression checks. Media is deliberately mocked; this is not a
// listening test or a substitute for the real-browser playback checks.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const args=process.argv.slice(2),option=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
const {JSDOM,VirtualConsole}=require(path.resolve(option('--jsdom')));
const root=path.resolve(option('--html-dir')||'math');
(async()=>{
 const report=[];
 for(const filename of fs.readdirSync(root).filter(name=>name.endsWith('.html')&&(!option('--only')||name.includes(option('--only'))))){
  let source=fs.readFileSync(path.join(root,filename),'utf8');
  const match=source.match(/<script id="recorded-lecture-data"[^>]*>(.*?)<\/script>/s);if(!match)continue;
  const data=JSON.parse(match[1]);
  source=source.replace(/(<script id="recorded-lecture-audio-source--[^"]+"[^>]*>).*?(<\/script>)/sg,'$1data:audio/mpeg;base64,$2');
  const errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
  const dom=new JSDOM(source,{url:'https://example.test/'+encodeURIComponent(filename)+'?lecture='+data.questions[0].id,runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(w){
   const playing=new WeakMap();
   Object.defineProperties(w.HTMLMediaElement.prototype,{readyState:{get(){return 1;}},paused:{get(){return !playing.get(this);}}});
   w.HTMLMediaElement.prototype.load=function(){this.dispatchEvent(new w.Event('loadedmetadata'));};
   w.HTMLMediaElement.prototype.play=function(){playing.set(this,true);return Promise.resolve();};
   w.HTMLMediaElement.prototype.pause=function(){playing.set(this,false);};
   w.SVGElement.prototype.getScreenCTM=()=>({a:1,b:0});w.SVGElement.prototype.getBBox=()=>({x:0,y:0,width:100,height:100});
   w.HTMLElement.prototype.scrollIntoView=function(){};w.HTMLElement.prototype.scrollTo=function(){};w.scrollTo=function(){};
   w.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
   w.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
   w.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
  }});
  await new Promise(resolve=>dom.window.addEventListener('load',resolve,{once:true}));
  const w=dom.window,doc=w.document,ui=doc.querySelector('#recorded-lecture-host').shadowRoot;
  assert(ui);assert.equal(ui.querySelectorAll('audio').length,1);assert(ui.querySelector('audio').paused);
  assert.equal(doc.querySelectorAll('script[id^="recorded-lecture-audio-source--"]').length,0);
  assert.equal(ui.querySelector('.transcript-content').querySelectorAll('li').length,data.units.length);
  ui.querySelector('.normal').click();
  const replace=w.history.replaceState;
  // Simulate a local-file viewer rejecting address writes during the new player.
  w.history.replaceState=()=>{throw new w.DOMException('History disabled for local viewer','SecurityError');};
  doc.querySelector('#recorded-lecture-launch,#mode-lecture,#lectureBtn,#lectureMode,#mode').click();
  assert(!ui.querySelector('.shell').hidden);
  const choose=(selector,value)=>{const el=ui.querySelector(selector);el.value=value;el.dispatchEvent(new w.Event('change'));};
  const first=data.questions[0];choose('.questions',first.id);ui.querySelector('.play').click();await Promise.resolve();
  choose('.step-select','1');await Promise.resolve();assert(!ui.querySelector('audio').paused);assert.equal(ui.querySelector('audio').currentTime,data.units[first.units[1]].start);
  ui.querySelector('.play').click();choose('.step-select','0');assert(ui.querySelector('audio').paused);
  w.history.replaceState=replace;
  for(const q of data.questions){choose('.questions',q.id);assert(ui.querySelector('audio').getAttribute('src').startsWith('data:audio/mpeg;base64,'));}
  const last=data.questions.at(-1);choose('.questions',last.id);choose('.step-select',String(last.units.length-1));
  assert.equal(ui.querySelector('.caption').textContent,data.units[last.units.at(-1)].displayText);
  ui.querySelector('.play').click();await Promise.resolve();assert(!ui.querySelector('audio').paused);
  const details=[...doc.querySelectorAll('details')].map(el=>[el,el.open]);
  w.dispatchEvent(new w.Event('beforeprint'));assert(ui.querySelector('audio').paused);
  w.dispatchEvent(new w.Event('afterprint'));for(const [el,open] of details)assert.equal(el.open,open);
  assert(ui.querySelector('audio').paused);
  ui.querySelector('.normal').click();assert(ui.querySelector('.shell').hidden);assert(!doc.body.style.overflow);
  assert.equal(doc.querySelectorAll('[inert]').length,0);
  assert.equal(errors.length,0,filename+': '+errors.join('; '));
  report.push({filename,units:data.units.length,questions:data.questions.length,printEvents:'pause/details restored/no automatic resume',mode:'closed and restored'});
  dom.window.close();console.log(JSON.stringify(report.at(-1)));
 }
 assert.equal(report.length,args.includes('--expected')?Number(option('--expected')):12,'All completed lessons must be checked.');
 if(args.includes('--report'))fs.writeFileSync(option('--report'),JSON.stringify(report,null,2));
})();
