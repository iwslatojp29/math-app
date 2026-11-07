const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const Tools=require('../sapix/teaching-tools.js');
const Lessons=require('../sapix/reproducible-lessons.js');
const Data=require('../sapix/november-lesson-data.js');
const Catalog=require('../sapix/generated-problems.js');
const Presentation=require('../sapix/generated-presentation.js');
const html=fs.readFileSync(path.join(__dirname,'../sapix/sapix_sansu_trainer.html'),'utf8');
const catalog=JSON.parse(fs.readFileSync(path.join(__dirname,'../sapix/problems/generated.json'),'utf8'));
const compiled=Catalog.compileCatalog(catalog).problems;
const lcmId='drive-1KloP00U3vHEl0Hczy9ED0Z3HUL3u33fJ-q1';

function originalHelper(name){
  const start=html.indexOf('function '+name+'('),part=html.slice(start),end=/^}/m.exec(part);
  assert.ok(start>0&&end);
  return vm.runInNewContext('('+part.slice(0,end.index+1)+')');
}
test('shared sudare and written-calculation components match the actual older lessons byte for byte',()=>{
  const rows=[{d:5,n:[30,45,75]},{d:3,n:[6,9,15]},{n:[2,3,5]}];
  assert.equal(Tools.ladder(rows),originalHelper('ladder')(rows));
  const written=[{s:'2178'},{s:'4',op:'×',line:true},{s:'8712',cls:'ann'}];
  assert.equal(Tools.vcalc(written,'逆順の数'),originalHelper('vcalc')(written,'逆順の数'));
});
test('sudare continues for two-number common factors and carries unshared numbers down',()=>{
  const rows=Lessons.lcmRows([156,104,65]);
  assert.deepEqual(rows,[{n:[156,104,65],d:13,part:false},{n:[12,8,5],d:4,part:true},{n:[3,2,{v:5}]}]);
  const gcd=(a,b)=>b?gcd(b,a%b):a;
  for(const numbers of [[30,45,75],[156,104,65],[72,180,210],[8,9,25],[6,10,15],[1,4,8]]){
    const rows=Lessons.lcmRows(numbers),last=rows.at(-1);
    const result=rows.slice(0,-1).reduce((n,r)=>n*r.d,1)*last.n.reduce((n,v)=>n*(typeof v==='object'?v.v:v),1);
    assert.equal(result,numbers.reduce((a,b)=>a/gcd(a,b)*b,1));
  }
});
test('the reported LCM regression has the old-style diagram, calculation, point, previous answer and check',()=>{
  const p=compiled.find(p=>p.id===lcmId);
  assert.match(p.expl,/aria-label="すだれ算"/);
  assert.match(p.expl,/13 × 4 × 3 × 2 × 5 ＝ 1560/);
  assert.match(p.expl,/<span class="calc">/);
  assert.match(p.expl,/1560 ÷ 156 ＝ 10/);
  assert.match(p.expl,/<h3>ポイント<\/h3>/);
  assert.deepEqual(p.prev,[{l:'(45)',a:'6240',ok:false,c:'1560'}]);
  assert.match(p.note,/もっと小さい1560/);
  assert.ok(!/<img\b|assets\/drive\//.test(p.body+p.figure+p.expl));
  const second=compiled.find(p=>p.id==='drive-11LCbJURR5fwBDYLqnwxxop067E8tUCOe-q1');
  assert.match(second.expl,/aria-label="すだれ算"/);
  assert.match(second.answers[0].v,/2520/);
});
test('all 63 reviewed lessons are present in catalog order and retain IDs, answer counts and source references',()=>{
  assert.equal(Data.lessons.length,63);
  assert.deepEqual(Data.lessons.map(p=>p.id),catalog.problems.map(p=>p.id));
  assert.deepEqual(compiled.map(p=>p.id),catalog.problems.map(p=>p.id));
  for(const [i,p] of compiled.entries()){
    assert.equal(p.lessonRevision,Data.revision);
    assert.equal(p.answers.length,catalog.problems[i].answers.length);
    assert.match(p.expl,/<h3>ポイント<\/h3>/);
    assert.match(p.expl,/たしかめ/);
    assert.deepEqual(p.sourceImages,catalog.problems[i].sourceImages);
    assert.ok(!/<img\b|data:image|assets\/drive\//i.test(p.body+p.figure+p.expl));
  }
});
test('source-reading corrections distinguish pencil answers from red corrections and omit illegible answers',()=>{
  for(const [id,previous,answer] of [
    ['1RDGLCameHBBe7Y5OXOrAFAjRcwZcsf7R','3/7','2/5'],
    ['1nZ3WuWMuA1zqyFagjSHmRz7MQgkvdNE4','107','167'],
    ['11ETVwx-Bm91S4mc4OOl1fsc2KN263Lw7','83','8.3']
  ]){
    const lesson=Data.lessons.find(p=>p.id==='drive-'+id+'-q1');
    assert.deepEqual(lesson.previous,[{label:'□',answer:previous,correct:false}]);
    const p=compiled.find(p=>p.id===lesson.id);
    assert.match(p.prev[0].c,new RegExp(answer.replace('/','[\\s\\S]*')));
  }
  for(const id of ['drive-1ruTp9qMIjPV0ZD7ngjJ9xpmYV8TW2dij-q1','drive-1dZ0mPXMSDKWu8U25sOh_cKtaZczf4UoM-q3']){
    const p=compiled.find(p=>p.id===id);
    assert.equal(p.prev,undefined);assert.equal(p.note,undefined);
  }
  const two=compiled.find(p=>p.id==='drive-1WVZpNmNtQ-HHuAYAGEeibQS0EddaDbn2-q1');
  assert.equal(two.prev[0].c,'1');assert.equal(two.prev[1].c,'34');
});
test('review text uses fixed escaped markup, including previous-answer labels and notes',()=>{
  const attack='<img src=x onerror=alert(1)></script><script>bad()</script>';
  const context=vm.createContext({SapixTeachingTools:Tools,SapixNovemberLessons:{revision:'test',lessons:[{id:'test',reasoning:[{text:attack,formula:attack}],check:{text:attack,formula:attack},point:attack,previous:[{label:attack,answer:attack,correct:false}],previousNote:attack}]}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../sapix/reproducible-lessons.js'),'utf8'),context);
  const out=context.SapixReproducibleLessons.render({id:'test',answers:[{label:'',text:'1'}]},{answers:[{l:'',v:'1'}]},{format:Presentation.format});
  for(const value of [out.expl,out.prev[0].l,out.prev[0].a,out.note]){
    assert.ok(!value.includes('<img')&&!value.includes('<script')&&!value.includes('</script>'));
    assert.match(value,/&lt;img/);
  }
});
test('browser dependencies load in order before catalog compilation',()=>{
  const context=vm.createContext({});
  let last=-1;
  for(const file of ['teaching-tools','november-lesson-data','reproducible-lessons','generated-presentation','generated-problems']){
    const index=html.indexOf('src="./'+file+'.js?v=20261107b"');
    assert.ok(index>last);last=index;
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../sapix/'+file+'.js'),'utf8'),context);
  }
  const result=context.SapixGeneratedProblems.compileCatalog(catalog).problems;
  assert.equal(result.find(p=>p.id===lcmId).prev[0].a,'6240');
});
