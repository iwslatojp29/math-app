const test=require('node:test');
const assert=require('node:assert/strict');
const {validFilename,contextFrom}=require('../shared/math-tutor.js');
test('lesson viewer accepts Japanese HTML filenames and rejects paths and management pages',()=>{
 assert(validFilename('2026年6月_学コン.html'));
 for(const name of ['../x.html','x/y.html','index.html','upload.html','delete.html','x.html\n',null])assert(!validFilename(name));
});
test('AI context prioritizes selected text and the visible question rather than offscreen material',()=>{
 const node=(text,top)=>({innerText:text,getBoundingClientRect:()=>({top,bottom:top+300,height:300})});
 const visible=node('表示している問題の説明。'.repeat(20),100),offscreen=node('別の問題。'.repeat(30),2000);
 const doc={defaultView:{innerHeight:800,getSelection:()=>({toString:()=> 'なぜ3で割る？'})},querySelectorAll:()=>[offscreen,visible],body:{innerText:'全文'}};
 const text=contextFrom(doc);assert(text.includes('なぜ3で割る？'));assert(text.includes(visible.innerText));assert(!text.includes(offscreen.innerText));
});
