/* Use the original SAPIX component vocabulary and a fixed lesson structure. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('./teaching-tools.js'),require('./november-lesson-data.js'));
  else root.SapixReproducibleLessons=factory(root.SapixTeachingTools,root.SapixNovemberLessons);
})(typeof globalThis!=='undefined'?globalThis:this,function(Tools,Data){
  'use strict';
  var lessons=new Map((Data&&Data.lessons||[]).map(function(l){return[l.id,l];}));
  function gcd(a,b){while(b){var t=a%b;a=b;b=t;}return a;}
  function lcmRows(numbers){
    var n=numbers.slice(),rows=[],keep=[];
    for(var count=0;count<30;count++){
      var all=n.reduce(gcd),d=all;
      if(d===1)for(var i=0;i<n.length;i++)for(var j=i+1;j<n.length;j++)d=Math.max(d,gcd(n[i],n[j]));
      rows.push({n:n.map(function(v,i){return keep[i]?{v:v}:v;}),...(d>1?{d:d,part:all===1}:{})});
      if(d<=1)return rows;
      keep=n.map(v=>v%d!==0);n=n.map(v=>v%d===0?v/d:v);
    }
    throw Error('invalid_lcm_rows');
  }
  function pointFor(unit){
    return ({計算:'計算の順番と小数点の位置を確かめ、答えをもとの式にもどして検算しましょう。',分数:'計算の前に約分できるかを見て、たし算・ひき算では分母をそろえましょう。',単位:'先に同じ単位にそろえてから計算し、最後に答えの単位を確かめましょう。',倍数:'最小公倍数は、どの数でも割り切れるだけでなく、いちばん小さいことが大切です。',平均算:'平均 × 人数 ＝ 合計、合計 ÷ 人数 ＝ 平均を使い分けましょう。',方陣算:'角を重ねて数えないように、増える部分や空いている部分を分けて考えましょう。',平面図形:'どの長さ・どの範囲を求めるかを図で確かめ、面積とまわりの長さを区別しましょう。',立体図形:'底面積 × 高さの変化で考え、長さと体積の単位を区別しましょう。',約数:'割った答えが整数になるのは、分子を割り切れる数のときです。',規則性:'動かす前後を1段ずつ記録し、ルールに合うか確かめましょう。'})[unit]||'条件を整理してから計算し、出した答えをもとの条件にもどして確かめましょう。';
  }
  function render(p,out,context){
    var fmt=context.format,lesson=lessons.get(p.id),calc=s=>'<span class="calc">'+fmt(s)+'</span>';
    if(lesson){
      out.lessonRevision=Data.revision;
      var preserve=/^drive-(1wDmrpC4YU-4rsrxxVrKJ62mDQWqgVt0y|1VMz4T8SW4U7E0VGUKAAyz5l-r_T75c6e)-/.test(p.id);
      var written='';
      if(p.id==='drive-1TYGm09QCcy4OIGWRlwOp37S4DlZ9zIqc-q1')written=Tools.vcalc([{s:'325'},{s:'48',op:'×',line:true},{s:'2600'},{s:'1300',shift:1,line:true},{s:'15600',cls:'ann'}],'小数点を取って325×48を計算する筆算');
      if(p.id==='drive-1O9kBY-EVWNwy1BRz-kKFAmec11SMtbhQ-q1')written=Tools.vcalc([{s:'2178'},{s:'4',op:'×',line:true},{s:'8712',cls:'ann'}],'2178を4倍すると逆順の8712になる筆算');
      if(written)written='<div class="fig-full" style="width:260px;max-width:100%">'+written+'</div>';
      var explanation=preserve?out.expl:'<h3>考え方</h3>'+(context.solution||'')+written+'<ol>'+lesson.reasoning.map(function(step){return '<li><p>'+fmt(step.text)+'</p>'+(step.formula?'<p>'+calc(step.formula)+'</p>':'')+'</li>';}).join('')+'</ol>';
      out.expl=explanation+'<h3>たしかめ</h3><p>'+fmt(lesson.check.text)+'</p>'+(lesson.check.formula?'<p>'+calc(lesson.check.formula)+'</p>':'')+'<h3>ポイント</h3><p>'+fmt(lesson.point)+'</p>';
      if(lesson.previous.length){
        out.prev=lesson.previous.map(function(v,i){
          var match=p.answers.findIndex(a=>a.label===v.label),answer=out.answers[match>=0?match:i];
          return {l:fmt(v.label==='答え'||v.label==='□'?'':v.label),a:fmt(v.answer),ok:v.correct,c:answer?answer.v:out.answers.map(a=>a.v).join('、')};
        });
        out.note=fmt(lesson.previousNote);
      }
    }else if(!out.expl.includes('<h3>ポイント</h3>'))out.expl+='<h3>ポイント</h3><p>'+fmt(pointFor(p.unit))+'</p>';
    var settings={
      'drive-1KloP00U3vHEl0Hczy9ED0Z3HUL3u33fJ-q1':{n:[156,104,65],label:'(45)',previous:'6240'},
      'drive-11LCbJURR5fwBDYLqnwxxop067E8tUCOe-q1':{n:[72,180,210],label:'(33)'}
    };
    var set=settings[p.id];
    if(set){
      var rows=lcmRows(set.n),factors=rows.filter(r=>r.d).map(r=>r.d).concat(rows[rows.length-1].n.map(v=>typeof v==='object'?v.v:v)),answer=factors.reduce((a,b)=>a*b,1);
      out.body='<p>次の数の最小公倍数を<ruby>求<rt>もと</rt></ruby>めましょう。</p>';
      out.questions=[{l:set.label,t:'（'+set.n.join('，')+'）'}];out.answers=[{l:set.label,v:String(answer)}];
      var descriptions=rows.slice(0,-1).map(function(row,i){var n=rows[i+1].n.map(v=>typeof v==='object'?v.v:v);return row.d+'で割って '+n.join('，')+(row.part?'。割れない数は、そのままおろします。':'。');});
      out.expl='<h3>'+set.n.join('，')+' の最小公倍数</h3>'+Tools.ladder(rows)+'<p>'+descriptions.map(fmt).join(' ')+'</p><p>最小公倍数は、左の数と下の数を<b>全部かける</b>：</p><p>'+calc(factors.join(' × ')+' ＝ '+answer)+'</p><p>たしかめ：'+fmt(set.n.map(n=>answer+' ÷ '+n+' ＝ '+answer/n).join('、'))+' ✓</p><h3>ポイント</h3><p>3つの数の最小公倍数では、<b>2つだけ割れるときも割ってよい</b>。割れない数はそのままおろします。最大公約数のときは「全部割れる数」だけ、というちがいに注意しましょう。</p>';
      if(set.previous){
        out.prev=[{l:set.label,a:set.previous,ok:false,c:String(answer)}];out.lessonRevision=Data&&Data.revision||'20261107b';
        out.note='6240＝13×12×8×5です。13で割った後の12と8は、まだ4で割れます。ここをさらに割って13×4×3×2×5＝1560にしましょう。6240も公倍数ですが、もっと小さい1560で割り切れるため最小ではありません。';
      }
    }
    return out;
  }
  return{render:render,lcmRows:lcmRows,revision:Data&&Data.revision||'20261107b'};
});
