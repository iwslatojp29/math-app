/* Authored, clean teaching diagrams. Source photographs are reference-only.
   Stable problem IDs and grading data are never changed by this presentation. */
(function(root,factory){
  if(typeof module==='object'&&module.exports) module.exports=factory(require('./reproducible-lessons.js'));
  else root.SapixGeneratedPresentation=factory(root.SapixReproducibleLessons);
})(typeof globalThis!=='undefined'?globalThis:this,function(Lessons){
  'use strict';
  function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function fraction(n,d){return '<span class="frac" aria-label="'+esc(d)+'分の'+esc(n)+'"><span class="num">'+esc(n)+'</span><span class="den">'+esc(d)+'</span></span>';}
  function format(s){
    return esc(s).replace(/(\d+)\s+(\d+)\/(\d+)(?!\d)/g,(_,w,n,d)=>'<span class="mixed"><span class="whole">'+w+'</span>'+fraction(n,d)+'</span>')
      .replace(/(?<![\w>])(\d+)\/(\d+)(?!\d)/g,(_,n,d)=>fraction(n,d))
      .replace(/□|［\s*］/g,'<span class="blank" aria-label="空欄">□</span>');
  }
  function paras(s){return s.split(/\n\s*\n/).map(t=>'<p>'+format(t).replace(/\n/g,'<br>')+'</p>').join('');}
  function txt(x,y,s,cls,extra){return '<text x="'+x+'" y="'+y+'"'+(cls?' class="'+cls+'"':'')+(extra?' '+extra:'')+'>'+esc(s)+'</text>';}
  function line(x1,y1,x2,y2,cls){return '<line class="'+(cls||'edge')+'" x1="'+x1+'" y1="'+y1+'" x2="'+x2+'" y2="'+y2+'"/>';}
  function svg(w,h,body,label){return '<svg class="figsvg" viewBox="0 0 '+w+' '+h+'" role="img" aria-label="'+esc(label)+'">'+body+'</svg>';}
  function frame(s,w){return '<div class="fig-full" style="width:'+w+'px;max-width:100%">'+s+'</div>';}
  function poly(points,cls){return '<polygon class="'+(cls||'edge')+'" points="'+points.map(p=>p.join(',')).join(' ')+'"/>';}
  function graph(solution){
    var s='',x=36,y=24,base=210,dx=34,dy=17,values=[3,4,6,8,5,5,3];
    for(var n=0;n<=9;n++)s+=line(x,base-n*dy,x+242,base-n*dy,'grid')+txt(x-9,base-n*dy+5,n,'','text-anchor="end"');
    s+=txt(9,20,'人数（人）');
    values.forEach(function(v,i){var xx=x+i*dx;
      if(i===4||i===5){var tear=base-v*dy+5;
        var shape='M'+xx+','+base+' V'+tear+' l7,-4 7,6 7,-6 7,5 6,-2 V'+base+'Z';
        s+='<path class="soft" d="'+shape+'"/><path class="edge" d="'+shape+'"/>';
      }else s+='<rect x="'+xx+'" y="'+(base-v*dy)+'" width="'+dx+'" height="'+v*dy+'" class="soft"/><rect x="'+xx+'" y="'+(base-v*dy)+'" width="'+dx+'" height="'+v*dy+'" class="edge"/>';
      s+=txt(xx+dx/2,base+23,i*5,'','text-anchor="middle"');
    });
    s+=line(x,base,x+242,base)+txt(210,255,'得点（点）');
    s+=txt(20,281,'上が破れた棒：20点・25点');
    if(solution)s+=txt(20,307,'少なくとも5人ずついる。','ann');
    return frame(svg(320,solution?327:302,s,'0〜30点、5点きざみの棒グラフ。20点と25点の上部は破れている。'),320);
  }
  function sector(radius,degrees,solution){
    var cx=140,cy=140,r=100,a=-degrees*Math.PI/180,ex=cx+r*Math.cos(a),ey=cy+r*Math.sin(a);
    var s='<path class="edge" d="M'+cx+','+cy+' L'+(cx+r)+','+cy+' A'+r+','+r+' 0 '+(degrees>180?1:0)+' 0 '+ex+','+ey+' Z"/>';
    s+='<path class="arc" d="M'+(cx+25)+','+cy+' A25,25 0 '+(degrees>180?1:0)+' 0 '+(cx+25*Math.cos(a))+','+(cy+25*Math.sin(a))+'"/>';
    s+=txt(cx+28*Math.cos(a/2),cy+28*Math.sin(a/2)-6,degrees+'°','ann','text-anchor="middle"');
    s+=txt(cx+50,cy+21,radius+'cm','','text-anchor="middle"');
    if(solution){s+='<path class="arc2" d="M'+(cx+r)+','+cy+' A'+r+','+r+' 0 '+(degrees>180?1:0)+' 0 '+ex+','+ey+'"/>';s+=txt(20,281,'まわり ＝ 弧 ＋ 半径 ＋ 半径','ann');}
    return frame(svg(280,solution?300:260,s,'半径'+radius+'cm、中心角'+degrees+'度のおうぎ形'),280);
  }
  function tank(solution){
    var s='',boxes=[[18,'入れる前',false],[172,'入れた後',true]];
    boxes.forEach(function(v){var x=v[0],y=55;
      s+='<rect class="edge" x="'+x+'" y="'+y+'" width="110" height="140"/>';
      var water=195-(v[2]?15:13)*140/60;s+='<rect class="soft" x="'+x+'" y="'+water+'" width="110" height="'+(195-water)+'"/>'+line(x,water,x+110,water,'arc');
      if(v[2])s+='<path class="edge" d="M'+(x+34)+',190 q-10,-14 10,-14 q24,-2 27,13z"/>';
      s+=txt(x+55,27,v[1],'','text-anchor="middle"')+txt(x+55,223,'35cm','','text-anchor="middle"')+txt(x+5,246,'奥行き25cm')+txt(x+72,water-7,v[2]?'15cm':'13cm','ann');
    });
    s+=txt(18,275,'水そうの高さ：60cm');if(solution)s+=txt(18,303,'上がった高さ：15 − 13 ＝ 2cm','ann');
    return frame(svg(300,solution?325:294,s,'内のり25cm×35cm、高さ60cmの水そう。石を入れると深さ13cmから15cmへ上がる。'),300);
  }
  function square(n,hollow,solution){
    var s='',cell=n===13?17:28,off=24,size=n*cell;
    for(var r=0;r<n;r++)for(var c=0;c<n;c++){
      if(hollow&&r>=3&&r<n-3&&c>=3&&c<n-3)continue;
      s+='<circle cx="'+(off+c*cell+cell/2)+'" cy="'+(off+r*cell+cell/2)+'" r="'+(cell*.3)+'" class="edge"/>';
    }
    s+=txt(off+size/2,size+off+25,'1辺 '+n+'こ','','text-anchor="middle"');
    if(hollow)s+=txt(off+size/2,17,'幅は3列','','text-anchor="middle"');
    if(solution&&hollow)s+='<rect class="diag" x="'+(off+3*cell)+'" y="'+(off+3*cell)+'" width="'+(7*cell)+'" height="'+(7*cell)+'"/>'+txt(off+size/2,size/2+off+5,'7 × 7 の空き','ann','text-anchor="middle"');
    return frame(svg(size+48,size+68,s,hollow?'1辺13こ、幅3列の中空方陣':'1辺5この正方形に並べた碁石'),hollow?290:220);
  }
  function lshape(growing,solution){
    var s='<rect class="soft" x="35" y="35" width="140" height="140"/><rect class="edge" x="35" y="35" width="140" height="140"/>';
    s+='<path class="soft2" d="M175,35 H200 V200 H35 V175 H175Z"/><path class="edge" d="M175,35 H200 V200 H35 V175 H175Z"/>';
    s+=txt(98,109,growing?'もとの正方形':'小さい正方形','','text-anchor="middle"')+txt(213,105,'1列','ann2')+txt(81,224,'1列','ann2');
    s+=txt(20,256,growing?'右と下に1列ずつふやす':'右と下の1列を取りのぞく');
    if(solution)s+=txt(20,282,growing?'2辺の人数 ＋ 角の1人':'2辺の枚数 − 重なる角の1枚','ann');
    return frame(svg(280,solution?304:277,s,'正方形の1列の増減はL字形の部分'),280);
  }
  var oct=[[1,0],[2,0],[3,1],[3,2],[2,3],[1,3],[0,2],[0,1]];
  function wood(q,solution){
    var s='',scale=25;
    function octagon(x,y,rot){var points=oct.map(function(p){var a=p[0]-1.5,b=p[1]-1.5;if(rot)return [x+(a-b)*scale/Math.sqrt(2),y+(a+b)*scale/Math.sqrt(2)];return [x+a*scale,y+b*scale];});return poly(points,'soft')+poly(points);}
    s+=octagon(58,74,false)+txt(58,142,'図形A','','text-anchor="middle"');
    for(var i=0;i<=3;i++)s+=line(20+i*scale,36,20+i*scale,111,'grid')+line(20,36+i*scale,95,36+i*scale,'grid');
    s+=txt(58,166,'1ます：1cm × 1cm','','text-anchor="middle"');
    if(q!==3){
      for(var r=0;r<2;r++)for(var c=0;c<2;c++)s+=octagon(183+c*75,54+r*75,false);
      s+=txt(220,192,q===1?'4個をつないだ図':'1cmの辺でつなぐ','','text-anchor="middle"');
      if(solution)s+=poly([[220.5,66.5],[245.5,91.5],[220.5,116.5],[195.5,91.5]],'soft2');
    }else{
      for(var r=0;r<2;r++)for(var c=0;c<2;c++)s+=octagon(185+c*70.71,48+r*70.71,true);
      s+=txt(225,192,'ななめの辺でつなぐ','','text-anchor="middle"');
    }
    if(q===2)s+=txt(20,232,'縦2個 × 横50個（図は一部分）');
    if(q===3)s+=txt(20,232,'縦10個 × 横10個（図は一部分）');
    if(solution)s+=txt(20,263,q===3?'すき間：1cm²ずつ':'すき間：2cm²ずつ','ann');
    return frame(svg(337,solution?285:252,s,'正方形5個からつくる八角形Aと、その並べ方。'+(q===3?'斜めの辺でつなぐ。':'長さ1cmの辺でつなぐ。')),420);
  }
  var voronoiPoints=[[[2,2,'A'],[4,4,'B']],[[3,2,'A'],[3,4,'B'],[5,4,'C']],[[5,7,'A'],[3,5,'B'],[3,3,'C']]];
  var voronoiRegions=[[[0,0],[6,0],[0,6]],[[0,0],[7,0],[4,3],[0,3]],[[2,8],[8,8],[8,3],[6,4]]];
  function voronoi(q,solution){
    var x=28,y=25,k=29,sz=8*k,s='';
    function to(p){return[x+p[0]*k,y+sz-p[1]*k];}
    if(solution)s+=poly(voronoiRegions[q-1].map(to),'soft');
    for(var i=0;i<=8;i++)s+=line(x+i*k,y,x+i*k,y+sz,'grid')+line(x,y+i*k,x+sz,y+i*k,'grid');
    s+='<rect class="edge" x="'+x+'" y="'+y+'" width="'+sz+'" height="'+sz+'"/>';
    voronoiPoints[q-1].forEach(function(p){var a=to(p);s+='<circle class="pt" cx="'+a[0]+'" cy="'+a[1]+'" r="4"/>'+txt(a[0]+8,a[1]-8,p[2]);});
    if(solution){var borders=q===1?[[[0,6],[6,0]]]:q===2?[[[0,3],[4,3]],[[4,3],[7,0]]]:[[[2,8],[6,4]],[[6,4],[8,3]]];borders.forEach(function(b){var a=to(b[0]),c=to(b[1]);s+=line(a[0],a[1],c[0],c[1],'arc2');});}
    if(solution&&q===1)s+=txt(28+3*k,275,'6m','ann','text-anchor="middle"')+txt(3,170,'6m','ann');
    if(solution&&q===2)s+=txt(28+3.5*k,275,'7m','ann','text-anchor="middle"')+txt(28+2*k,161,'4m','ann','text-anchor="middle"')+txt(2,220,'3m','ann');
    if(solution&&q===3)s+=poly([[6,4],[8,3],[8,2]].map(to),'soft2');
    s+=txt(145,300,'1ます：1m × 1m','','text-anchor="middle"');
    s+=txt(145,324,solution?'青色がAにいちばん近い部分':'広場は1辺8mの正方形',solution?'ann':'','text-anchor="middle"');
    return frame(svg(290,344,s,'図'+(q+1)+'。8m四方の広場の格子上の点'+voronoiPoints[q-1].map(p=>p[2]+'は左から'+p[0]+'m、下から'+p[1]+'m').join('、')+(solution?'。色のついた部分が答えの範囲。':'')),290);
  }
  var boards=['WBWBWBWB..','W..BWBWBBW','WWBB..WBBW','WWBBBBW..W','..BBBBWWWW'];
  function stoneAnswer(board){
    var s='';for(var j=0;j<10;j++){var x=4+j*26;s+=txt(x+13,14,j+1,'','text-anchor="middle"')+'<rect class="thin" x="'+x+'" y="22" width="26" height="27"/>';
      if('WB'.includes(board[j]))s+='<circle cx="'+(x+13)+'" cy="35" r="8" stroke="var(--ink)" stroke-width="1.5" fill="'+(board[j]==='B'?'var(--ink)':'var(--panel)')+'"/>';
    }return svg(270,55,s,'1番から順に '+board.replace(/W/g,'白 ').replace(/B/g,'黒 ').replace(/\./g,'空 '));
  }
  function stones(target,solution){
    var s='',rows=solution?[['はじめ',boards[0]],['1回目',boards[1]],['2回目',boards[2]],['3回目',boards[3]],['さいご',boards[4]]]:[['はじめ',boards[0]],[target+'回目','??????????'],['さいご',boards[4]]];
    rows.forEach(function(row,i){var y=28+i*51;s+=txt(3,y+23,row[0]);
      for(var j=0;j<10;j++){var x=65+j*25;s+='<rect class="thin" x="'+x+'" y="'+y+'" width="25" height="27"/>';
        if(i===0)s+=txt(x+12,y-5,j+1,'','text-anchor="middle"');
        if('WB'.includes(row[1][j]))s+='<circle cx="'+(x+12)+'" cy="'+(y+14)+'" r="8" stroke="var(--ink)" stroke-width="1.5" fill="'+(row[1][j]==='B'?'var(--ink)':'var(--panel)')+'"/>';
      }
    });
    return frame(svg(325,rows.length*51+25,s,solution?'4回の正しい碁石の移動':'碁石を4回動かす問題。'+target+'回目の列を答える。'),420);
  }
  function fractionGrid(solution){
    var cells=[[0,0,'1/4'],[0,1,solution?'5/8':'ア'],[1,1,solution?'4/5':'イ'],[0,2,solution?'1/8':'ウ'],[1,2,'1/5'],[2,2,solution?'8/9':'エ']],s='';
    cells.forEach(function(c){var x=47+c[0]*58,y=20+c[1]*58;s+='<rect class="edge" x="'+x+'" y="'+y+'" width="58" height="58"/>';
      if(c[2].includes('/')){var f=c[2].split('/');s+=txt(x+29,y+23,f[0],'','text-anchor="middle"')+line(x+16,y+29,x+42,y+29)+txt(x+29,y+48,f[1],'','text-anchor="middle"');}
      else s+=txt(x+29,y+36,c[2],'ann','text-anchor="middle"');
    });
    s+=txt(29,113,'あ')+txt(29,171,'い')+txt(69,218,'①')+txt(129,218,'②');
    return frame(svg(260,240,s,'6つの分数のます。縦①は1/4、ア、ウ。縦②はイ、1/5。横あはア、イ。横いはウ、1/5、エ。'),260);
  }
  var key={graph:'1ILEre5IpJ4VF-VyjsRuyLy2TD7wkMQsF',sector:'1OPVUJ4q1vHEhtGIUhSznwTnO8RnYzZbJ',tank:'13UB3ZgavlRdv0auKutaGuqyQxL9e07-L',hollow:'1XXt10gtB8ZY01PMVdRInQS4TX_9ae2sS',wood:'1qdKmVaRd5rxS0tJaZtx6xqZ0eKKTn6jX',voronoi:'1VMz4T8SW4U7E0VGUKAAyz5l-r_T75c6e',stones:'1k1zv0VGGzd5IVQK2OM_3kPtZPGKcOZAb',fractions:'1PpUHjBiv88JCvMy_hlt5QAN_y0_gbZow',people:'1VLsLRWM61wCZrJ-oDVxExysJQvn899D8'};
  function enhance(p,out){
    var m=/^drive-(.+)-q(\d+)$/.exec(p.id),file=m&&m[1],q=m?+m[2]:0;
    out.figure='';out.body=paras(p.question);out.answers=p.answers.map(a=>({l:esc(a.label==='答え'||a.label==='答'||a.label==='□'?'':a.label),v:format(a.text.replace(/（＝13.5）/,'').replace(/（3と15分の2。仮分数で表すと 47\/15）/,''))}));
    out.expl=p.steps.map(step=>'<h3>'+esc(step.title)+'</h3>'+paras(step.text)).join('');
    if(file==='1wDmrpC4YU-4rsrxxVrKJ62mDQWqgVt0y'){
      var division=txt(92,24,'0')+txt(109,24,'.')+txt(125,24,'4')+txt(158,24,'5')+txt(48,62,'8')+txt(92,62,'3')+txt(109,62,'.')+txt(125,62,'6')+txt(158,62,'0')+'<path class="edge" d="M75,76 Q85,58 75,40 H180"/>'+txt(92,98,'3')+txt(125,98,'2')+line(88,106,145,106)+txt(125,140,'4')+txt(158,140,'0')+txt(125,173,'4')+txt(158,173,'0')+line(120,181,179,181)+txt(158,208,'0')+txt(194,99,'36 ÷ 8','ann')+txt(194,174,'40 ÷ 8','ann');
      out.expl='<h3>筆算で小数点をそろえる</h3>'+frame(svg(300,224,division,'3.60÷8の筆算。商0.45、最後のあまり0。'),300)+'<ol><li>3は8でわれないので、一の位は0。小数点を3.6の真上にそろえます。</li><li>36 ÷ 8 ＝ 4 あまり4。十分の一の位に4を書きます。</li><li>3.6を3.60と考え、次の0をおろします。40 ÷ 8 ＝ 5。百分の一の位に5を書きます。</li></ol><h3>答えとたしかめ</h3><p><span class="calc">0.45 × 8 ＝ 3.6</span> なので、答えは <b>0.45</b> です。</p>';
    }
    var solution='';
    if(file===key.graph){
      out.body=paras('あるクラスの算数のテスト結果を表したグラフです。30点満点、5点きざみですが、一部分が破れています。');
      var asks=['クラスの人数が最も少ない場合、何人ですか。また、そのときの平均点は何点ですか。四捨五入して小数第1位まで求めなさい。','平均点が17.2点、クラスの人数が50人だったとき、20点の人は何人ですか。','25点の人が最も多く、15点の人の順位はクラスの人数の半分と同じです。同点の人は同じ順位とします（30点の3人が1位、次の25点の人は全員4位）。クラスの人数は何人ですか。','25点の人が最も多く、15点の人の順位はクラスの人数の半分と同じです。同点は同じ順位とします。平均点が最も低い場合は何点ですか。四捨五入して小数第1位まで求めなさい。'];
      out.body+=paras(asks[q-1]);out.figure=graph(false);solution=graph(true);
    }else if(file===key.sector){out.body=paras('円周率を3.14として、図形のまわりの長さを求めなさい。');out.figure=sector(q===1?12:10,q===1?75:234,false);solution=sector(q===1?12:10,q===1?75:234,true);}
    else if(file===key.tank){out.body=paras('内のりがたて25cm、横35cm、高さ60cmの水そうに、深さ13cmまで水を入れました。\n石を全部しずめると、水の深さは15cmになりました。石の体積は何cm³ですか。');out.figure=tank(false);solution=tank(true);}
    else if(file===key.hollow){out.body=paras('図のように、いちばん外側の1辺が13こ、幅が3列の中空方陣があります。おはじきは全部で何こですか。');out.figure=square(13,true,false);solution=square(13,true,true);}
    else if(file===key.wood){
      out.body=paras('1辺1cmの正方形5個を十字形に並べ、外側の頂点を結んだものを図形Aとします。図のように並べた外側の辺に、木の板がぴったりくっつく木わくを作ります。木わくの厚さは考えません。')+wood(q,false);
      out.body+=paras(q===1?'図形Aを1cmの辺どうしでつなぎ、縦2個・横2個に並べた木わくの内部の面積を求めなさい。':q===2?'図形Aを1cmの辺どうしでつなぎ、縦2個・横50個に並べます。木わくの内部の面積を求めなさい。':'図形Aのななめの辺どうしをつなぎ、縦10個・横10個に並べます。木わくの内部の面積を求めなさい。');solution=wood(q,true);
    }else if(file===key.voronoi){
      out.body=paras('1辺8mの正方形の広場に、1mごとの線と、図の位置に印があります。\n広場の中で、Aまでのまっすぐな距離が、ほかのどの印までの距離よりも短くなる部分の面積を求めなさい。印の大きさは考えません。');out.figure=voronoi(q,false);solution=voronoi(q,true);
      var reasoning=[
        '<h3>境目は、AとBのちょうど真ん中</h3><p>AとBを結ぶ線の真ん中を通り、それに直角な線が境目です。この線で折るとAとBが重なります。</p><p>方眼を数えると、境目は左の辺の下から6mの点と、下の辺の左から6mの点を結びます。</p><h3>A側の三角形を計算する</h3><p>Aがある左下側が求める部分です。底辺6m、高さ6mなので、</p><p><span class="calc">6 × 6 ÷ 2 ＝ 18 m²</span></p>',
        '<h3>2本の境目で囲む</h3><p>AとBの真ん中は下から3mの横線です。AとCの真ん中を通り、ACに直角な線は、右下がりのななめの線になります。</p><p>Aは両方の境目より下側にあります。重なる部分は、上底4m、下底7m、高さ3mの台形です。長さは方眼を数えて確認できます。</p><h3>台形の面積</h3><p><span class="calc">（4 ＋ 7）× 3 ÷ 2 ＝ 16.5 m²</span></p>',
        '<h3>まず、AとBの境目を見る</h3><p>AとBの真ん中を通り、ABに直角な線を引きます。Aに近い右上側は、底辺6m、高さ6mの三角形です。</p><p><span class="calc">6 × 6 ÷ 2 ＝ 18 m²</span></p><h3>CよりもAに近い部分にしぼる</h3><p>AとCの真ん中を通り、ACに直角な境目も引きます。右下の赤い小三角形は、AよりCに近いので取り除きます。</p><p>赤い三角形の右の辺は1m、そこまでの横の高さは2mです。</p><p><span class="calc">1 × 2 ÷ 2 ＝ 1 m²</span></p><h3>答え</h3><p><span class="calc">18 − 1 ＝ 17 m²</span></p>'
      ];out.expl=reasoning[q-1];
    }else if(file===key.stones){
      out.body=paras('1〜10番のますに、白石と黒石が4こずつ並んでいます。となり合う2こを、左右の順を変えず、あいている2ますへ移します。\n4回の移動で「さいご」の形にするとき、'+q+'回目の並びを答えなさい。');out.body+=stones(q,false);solution=stones(q,true);
      out.answers=[{l:q+'回目',v:stoneAnswer(boards[q])}];
    }else if(file===key.fractions){
      var target=['ア','イ','ウ','エ'][q-1];
      out.body=paras('6このますには分数が入ります。次の条件に合うように、'+target+'にあてはまる数を答えなさい。')+fractionGrid(false);
      out.body+='<ol class="nov-conditions"><li>縦①の3この数をたすと1。</li><li>縦②の2この数をたすと1。</li><li>横あの2この数をかけると'+fraction(1,2)+'。</li><li>横いの3この数をかけると'+fraction(1,45)+'。</li></ol>';
    }else if(file===key.people){out.body=paras('生徒を正方形に並べると27人あまり、たて・横を1列ずつふやすと2人足りません。\n'+['1列ずつふやすためには、何人必要ですか。','はじめの正方形の1辺には、何人並んでいますか。','生徒は全部で何人ですか。'][q-1]);solution=lshape(true,true);}
    else{
      // Re-typeset the complete source text; do not reuse photographed writing.
      var body=p.question.replace(/（\dと[^）]*答えを□に書きます。）/g,'').replace(/^次の計算をしなさい。\n/,'').replace(/^次の□にあてはまる数を(?:求め|答え)なさい。\n+/,'').replace(/^\(\d+\)\s*/,'');
      out.body=paras(body);
      if(['計算','単位','分数','小数'].includes(p.unit)&&body.length<150&&/^[\d□④（(]/.test(body)&&!/[まい人ます個こののはですを]/.test(body)){
        var expression=body.replace(/\n/g,' ').replace(/＝\s*$/,'＝ □');
        if(!expression.includes('□')&&!expression.includes('=' )&&!expression.includes('＝'))expression+=' ＝ □';
        expression=expression.replace(/\s*([×÷＋+＝=−－])\s*/g,' $1 ');
        out.body='<p>□にあてはまる数を求めなさい。</p><div class="nov-equation">'+format(expression)+'</div>';
      }
      if(file==='1FQmbM1ohLFAzNQ1cLQIdECedTYWpBSB8'){out.figure=square(5,false,false);solution=lshape(true,true);}
      if(file==='1umWZASaX6EC_KvIeauzMdj6tl2sUZdFi'||file==='1tWx4goIq4swIkoDt7vQKvqakVUZZZaXi')solution=lshape(false,true);
    }
    if(solution)out.expl='<h3>図で考えよう</h3>'+solution+out.expl;
    if(Lessons)out=Lessons.render(p,out,{format:format,solution:solution});
    out.body='<div class="nov-problem">'+out.body+'</div>';
    out.answers=out.answers.map(a=>({l:a.l,v:'<span class="nov-answer">'+a.v+'</span>'}));
    out.expl='<div class="nov-explanation">'+out.expl+'</div>';
    return out;
  }
  return{enhance:enhance,format:format};
});
