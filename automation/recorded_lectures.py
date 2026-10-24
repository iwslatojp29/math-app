"""Convert existing lecture data without changing the original written lessons.

Audio is generated locally with VOICEVOX; no lesson text is sent to a service.
"""
from __future__ import annotations
import argparse, base64, hashlib, html, io, json, re, wave
from pathlib import Path
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
NS = 'http://www.w3.org/2000/svg'

def plain(value):
    return BeautifulSoup(str(value or '').replace('<br>', '\n').replace('<br/>', '\n'), 'html.parser').get_text(' ', strip=True)

def block(source, name):
    m = re.search(r'<script[^>]*id=["\']'+re.escape(name)+r'["\'][^>]*>(.*?)</script>', source, re.S)
    return json.loads(m[1]) if m else None

def literal(source, name):
    m = re.search(r'(?:\b(?:const|let|var)\s+|,)\s*'+name+r'\s*=\s*', source)
    if not m: raise ValueError('Missing data: '+name)
    return json.JSONDecoder().raw_decode(source[m.end():])[0]

def spoken(text):
    """Initial pronunciation pass; per-unit exceptions remain independently editable."""
    text = plain(text)
    text = re.sub(r'√(\d+)\s*/\s*(\d+)',lambda m:'2乗すると'+m[1]+'になる数を、'+m[2]+'で割った値',text)
    text = re.sub(r'√(\d+)',lambda m:'2乗すると'+m[1]+'になる数',text)
    def comparison(m):
        parts=re.split(r'([＞>＜<≥≧≤≦])',m[0]);clauses=[]
        for i in range(1,len(parts),2):
            left,op,right=parts[i-1:i+2]
            clauses.append(left+'は'+right+({'＞':'より大きく','>':'より大きく','＜':'より小さく','<':'より小さく','≥':'以上','≧':'以上','≤':'以下','≦':'以下'}[op]))
        phrase='、'.join(clauses).removesuffix('く')
        if phrase.endswith('大き'):phrase+='い'
        elif phrase.endswith('小さ'):phrase+='い'
        if re.match(r'(?:も|を)満た',m.string[m.end():]):phrase+='という条件'
        return phrase
    text=re.sub(r'[A-Za-z0-9]+(?:[＞>＜<≥≧≤≦][A-Za-z0-9]+)+',comparison,text)
    length_units={'km':'キロメートル','cm':'センチメートル','mm':'ミリメートル','m':'メートル'}
    text=re.sub(r'(\d+(?:\.\d+)?)\s*(km|cm|mm|m)\s*/\s*(秒|分|時)',lambda m:'毎'+m[3]+m[1]+length_units[m[2]],text)
    replacements = {'cm³':'立方センチメートル','cm3':'立方センチメートル','cm²':'平方センチメートル','cm2':'平方センチメートル',
                    '㎠':'平方センチメートル','㎤':'立方センチメートル','km':'キロメートル','cm':'センチメートル','mm':'ミリメートル',
                    'm²':'平方メートル','m³':'立方メートル','mL':'ミリリットル','空になる':'からっぽになる','空になり':'からっぽになり',
                    '×':' かける ','÷':' わる ','＝':' は ','=':' は ','＋':' たす ','−':' ひく ','→':'、つまり、','⇒':'、したがって、',
                    '：':' 対 ','%':'パーセント','％':'パーセント','△':'三角形','□':'四角形','∠':'角','°':'度','≒':'およそ','≠':'と異なる'}
    # A possessive の after minutes is different from a fraction denominator.
    text = re.sub(r'(\d+)分(?=の(?:\d+/\d+倍|[^\d]))',lambda m:minute_reading(int(m[1])),text)
    # Spell only the final time unit phonetically; retain a natural mixed script.
    text = re.sub(r'(\d+)\s*/\s*(\d+)分',lambda m:m[2]+'分の'+m[1]+'ふん',text)
    text = re.sub(r'(\d+)\s*/\s*(\d+)', lambda m:m[2]+'分の'+m[1], text)
    for old,new in replacements.items(): text=text.replace(old,new)
    text=re.sub(r'(?<=\d)\s*kg(?![A-Za-z])','キログラム',text)
    text=re.sub(r'(?<=\d)\s*g(?![A-Za-z])','グラム',text)
    text=re.sub(r'(?<=\d)\s*m(?![A-Za-z0-9])','メートル',text)
    text=re.sub(r'(?<=を)m(?=にそろ|へ直|に直)','メートル',text)
    text = re.sub(r'([A-Za-z0-9]+)²',r'\1の2乗',text)
    text = re.sub(r'(?<![\d.の])(\d+(?:\.\d+)?)分(?!の)', lambda m:(m[1]+'ふん') if '.' in m[1] else minute_reading(int(m[1])), text)
    text = re.sub(r'(?<=[0-9０-９])\s*L(?![A-Za-z])', 'リットル', text)
    text = re.sub(r'(\d+)\s*\^\s*(\d+)',r'\1の\2乗',text)
    text = re.sub(r'(?<=\d)・(?=\d)','、',text)
    text = re.sub(r'(?<=[A-Z0-9]):(?=[A-Z0-9])',' 対 ',text)
    text = text.replace('〜','から').replace('～','から').replace('空の','からの').replace('空に','からっぽに')
    names=dict(zip('ABCDEFGHIJKLMNOPQRSTUVWXYZ',['エー','ビー','シー','ディー','イー','エフ','ジー','エイチ','アイ','ジェー','ケー','エル','エム','エヌ','オー','ピー','キュー','アール','エス','ティー','ユー','ブイ','ダブリュー','エックス','ワイ','ゼット']))
    text = re.sub(r'[A-Za-z]+', lambda m:'、'.join(names[c.upper()] for c in m[0]), text)
    text = text.translate(str.maketrans({chr(0x2460+i):'丸'+str(i+1) for i in range(20)}))
    return re.sub(r'\s+', ' ', text).strip()

def pronunciation_plan(text,filename,qid):
    """Explicitly interpret problem-specific notation using its own definition."""
    readings=[]
    def replace(pattern,fn,reason):
        nonlocal text
        def convert(m):
            value=fn(m);readings.append({'written':m[0],'spoken':value,'reason':reason});return value
        text=re.sub(pattern,convert,text)
    if '2026年11月号_整数' in filename and qid=='d13':
        replace(r'(\d+)↓',lambda m:'1から'+m[1]+'までの積','この問題の下向き矢印は階乗を表す')
        replace(r'([A-Za-z])↓',lambda m:m[1]+'の下向き矢印','本文の記号名。冒頭で1からその数までの積と定義する')
    if '2026年11月号_発展' in filename and qid=='d4':
        replace(r'9\[([A-Za-z0-9]+)\]',lambda m:'9が'+m[1]+'個並ぶ数','この問題の9[N]の定義')
    if '2026年9月号' in filename:
        replace(r'英子宅',lambda m:'えいこの家','元の音声原稿にある人名の読みを保持する')
        replace(r'英子',lambda m:'えいこ','元の音声原稿の「えいこ」')
        replace(r'和子',lambda m:'かずこ','元の音声原稿の「かずこ」')
    replace(r'(休む(?:たび|ごと)に)(\d+L)',lambda m:'休むたびに、'+m[2],'助詞の「に」と数量が続いて聞こえないように区切る')
    replace(r'〈([^〈〉]+)〉',lambda m:'かっこ'+m[1]+'、','記号の意味は問題ごとの導入で確認する')
    replace(r'\[([A-Za-z0-9]+),([^\]]+)\]',lambda m:'かっこ'+m[1]+'、'+m[2]+'、かっことじ','約数を小さい順に指定する記号')
    return spoken(text),readings

def minute_reading(n):
    ones={0:'',1:'いっぷん',2:'にふん',3:'さんぷん',4:'よんぷん',5:'ごふん',6:'ろっぷん',7:'ななふん',8:'はっぷん',9:'きゅうふん'}
    tens={1:'じゅう',2:'にじゅう',3:'さんじゅう',4:'よんじゅう',5:'ごじゅう',6:'ろくじゅう',7:'ななじゅう',8:'はちじゅう',9:'きゅうじゅう'}
    if n==0:return 'ゼロふん'
    if n<10:return ones[n]
    if n<100:return (tens[n//10][:-1]+'っぷん') if n%10==0 else tens[n//10]+ones[n%10]
    return (str(n//100*100)+minute_reading(n%100)) if n%100 else str(n)+'ぷん'

def svg_snapshot(markup, focus=(), hidden=(), overlay='', attribute='data-k'):
    soup=BeautifulSoup(markup or '', 'xml'); svg=soup.find('svg')
    figures=soup.find_all('svg')
    if len(figures)>1:
        snapshots=[svg_snapshot(str(figure),focus,hidden,overlay,attribute) for figure in figures]
        return '<div class="recorded-pair">'+''.join(x[0] for x in snapshots)+'</div>',[key for x in snapshots for key in x[1]]
    if not svg:
        if not plain(markup):raise ValueError('A lecture unit has no diagram')
        return str(markup),[]
    ids=[]
    for i,node in enumerate(svg.find_all(True)):
        key=node.get(attribute)
        if str(key) in {str(v) for v in hidden}:node['style']='display:none'
        if key is not None and str(key) in {str(v) for v in focus}:
            node['id']=node.get('id') or f'focus-{i}'
            node['class']=' '.join([*(str(node.get('class','')).split()),'recorded-focus'])
            ids.append(node['id'])
    if overlay:
        fragment=BeautifulSoup('<svg xmlns="'+NS+'"><g>'+overlay+'</g></svg>','xml').find('g')
        fragment['class']='recorded-focus';fragment['id']='cue-overlay';ids.append('cue-overlay');svg.append(fragment)
    svg['style']='display:block;width:100%;height:auto;max-height:100%'
    return str(svg),ids

def numeric_diagram(text,title):
    """Visualize only quantities/formulas actually written in the source step."""
    text=plain(text);formulas=list(dict.fromkeys(re.findall(r'\d+(?:[＋+×÷−=＝/：:]\d+)+',text)))[:3]
    values=list(dict.fromkeys(re.findall(r'\d+(?:\.\d+)?(?:個|組|通り|倍|枚|円|人|段)?',text)))[:12]
    markup='<svg xmlns="'+NS+'" viewBox="0 0 720 470" role="img" aria-label="'+html.escape(title,quote=True)+'">'
    for i,line in enumerate([title[n:n+29] for n in range(0,min(len(title),58),29)]):markup+=f'<text x="360" y="{26+i*25}" text-anchor="middle" font-size="22">'+html.escape(line)+'</text>'
    for i,value in enumerate(values):
        x=45+(i%4)*170;y=68+(i//4)*80
        markup+=f'<g data-k="value-{i}"><rect x="{x}" y="{y}" width="150" height="62" rx="10" fill="#e8f4ef" stroke="#368476"/><text x="{x+75}" y="{y+42}" text-anchor="middle" font-size="30">{html.escape(value)}</text></g>'
    for i,formula in enumerate(formulas):markup+=f'<text data-k="formula-{i}" x="360" y="{355+i*42}" text-anchor="middle" font-size="26">{html.escape(formula)}</text>'
    return markup+'</svg>'

def semantic_chunks(text):
    """Keep reasons intact, and split long explanations at sentence boundaries."""
    text=plain(text)
    if len(text)<=180:return [text]
    sentences=re.findall(r'[^。！？]+[。！？]?|[。！？]',text)
    chunks=[];current=''
    for sentence in sentences:
        if current and len(current)+len(sentence)>125 and len(current)>=45:
            chunks.append(current);current=''
        current+=sentence
    if current:
        if chunks and len(current)<35:chunks[-1]+=current
        else:chunks.append(current)
    return chunks or [text]

def extract(path):
    source=path.read_text(encoding='utf-8-sig');soup=BeautifulSoup(source,'html.parser')
    result={'version':1,'filename':path.name,'title':soup.title.get_text(),'svgStyle':'\n'.join(s.get_text() for s in soup.select('style')),'questions':[],'units':[]}
    def question(qid,label,title,chapters=()):
        q={'id':qid,'label':str(label),'title':title,'conditions':'','chapters':list(chapters),'units':[]};result['questions'].append(q);return q
    def unit(q,step,ci,text,svg,focus=(),equation='',speech='',chapter='',diagram_id='',motions=(),facts=(),checkpoint='',reference=''):
        chunks=semantic_chunks(text)
        if len(chunks)>1:
            for index,chunk in enumerate(chunks):
                last=index==len(chunks)-1
                unit(q,step,ci,chunk,svg,focus,equation if last else '',speech,chapter+'｜'+str(index+1)+'/'+str(len(chunks)),diagram_id,motions if index==0 else (),facts if last else (),checkpoint if last else '',reference)
            return
        idx=len(result['units']);u={'id':q['id']+'-u'+str(len(q['units'])+1),'questionId':q['id'],'unitIndex':idx,'stepIndex':step,'cueIndex':ci,'title':chapter or q['title'],
          'displayText':plain(text),'speechText':'','pronunciationSource':plain(speech),'diagramId':diagram_id or q['id']+'-diagram','focusIds':list(focus),'equation':plain(equation),'svg':svg,'motions':list(motions),'facts':list(facts),'checkpoint':checkpoint}
        u['speechText'],u['pronunciations']=pronunciation_plan(u['displayText'],path.name,q['id'])
        if not u['displayText']:raise ValueError('Empty lecture text')
        if not u['focusIds']:
            # An overview may concern the whole figure. Prefer actual labels or
            # table entries named by the explanation, rather than a text box.
            markup=BeautifulSoup(svg,'html.parser');named=[]
            for node in markup.select('svg text,td,th,[data-focus]'):
                label=node.get_text('',strip=True)
                if len(label)>40 or not label:continue
                pattern=(r'(?<!\d)'+re.escape(label)+r'(?!\d)') if re.fullmatch(r'\d+(?:\.\d+)?',label) else re.escape(label)
                if re.search(pattern,plain(reference)+' '+u['displayText']+' '+u['equation']):
                    node['id']=node.get('id') or 'referenced-'+str(len(named));node['class']=[*node.get('class',[]),'recorded-focus'];named.append(node['id'])
            if not named:
                node=markup.find(['svg','table'])
                if node:node['id']=node.get('id') or 'diagram-overview';node['class']=[*node.get('class',[]),'recorded-focus'];named.append(node['id'])
            if not named:
                eq=markup.select_one('.equation')
                if eq:
                    # Highlight the written quantities themselves, not a frame
                    # around an explanation paragraph.
                    for text_node in list(eq.find_all(string=True)):
                        if not re.search(r'\d',str(text_node)):continue
                        fragment=BeautifulSoup('', 'html.parser')
                        for part in re.split(r'(\d+(?:/\d+)?)',str(text_node)):
                            if re.fullmatch(r'\d+(?:/\d+)?',part):
                                span=fragment.new_tag('span');span['class']=['recorded-focus'];span.string=part;fragment.append(span)
                            else:fragment.append(part)
                        for span in fragment.select('.recorded-focus'):span['id']='quantity-'+str(len(named));named.append(span['id'])
                        text_node.replace_with(fragment)
            if named:u['svg']=str(markup);u['focusIds']=named
        q['units'].append(idx);result['units'].append(u)
    data=block(source,'lesson-data')
    if isinstance(data,list):
        for item in data:
            q=question(item['id'],item.get('label',item['id']),item['title'],item.get('chapters',[]))
            q['conditions']=plain(item.get('conditions',''))
            if '2026年11月号_整数' in path.name and item['id'] in ['e4','d02','d13']:
                intro=q['conditions'].split('。')[0]+'。';svg,ids=svg_snapshot(numeric_diagram(intro,'この問題の記号と条件'));unit(q,-1,0,intro,svg,ids,chapter='この問題の記号と条件')
            for si,step in enumerate(item['steps']):
                for ci,cue in enumerate(step['cues']):
                    svg,ids=svg_snapshot(cue['svg'],cue.get('focus',[]))
                    unit(q,si,ci,cue['text'],svg,ids,cue.get('formula',''),cue.get('speech',''),step['title'],motions=cue.get('motion',[]),facts=cue.get('facts',[]))
    elif (data:=block(source,'lecture-data')) is not None:
        for qid,item in data.items():
            art=soup.find(id=qid);heading=art.find(['h2','h1']) if art else None
            q=question(qid,qid,plain(heading) if heading else qid,item.get('chapters',[]))
            q['conditions']=plain(art.select_one('.condition,.problem,.question-text')) if art else ''
            for si,step in enumerate(item['steps']):
                cues=step.get('cues') or [{'text':step['say'],'speech':step.get('narration',''),'focus':step.get('focus',[])}]
                for ci,cue in enumerate(cues):
                    overlay=step.get('overlay','')+cue.get('overlay','')
                    svg,ids=svg_snapshot(item['figures'][step['figure']],cue.get('focus',[]),step.get('hide',[]),overlay,'data-node')
                    unit(q,si,ci,cue['text'],svg,ids,cue.get('formula',step.get('formula','') if ci==len(cues)-1 else ''),cue.get('speech',''),step['title'],motions=step.get('motion',[]) if cue.get('motion') else [],checkpoint=step.get('checkpoint','') if ci==len(cues)-1 else '')
    elif (data:=block(source,'lecdata')) is not None:
        for qid,item in data.items():
            art=soup.find(id=qid);heading=art.find(['h2','h1']);q=question(qid,qid,plain(heading))
            q['chapters']=[{'label':sub,'steps':[i for i,step in enumerate(item['steps']) if sub in step.get('sub',[])]} for sub in item.get('subs',[])]
            visibility={};known=[]
            for si,step in enumerate(item['steps']):
                for ci,cue in enumerate(step['cues']):
                    vis=visibility.setdefault(step['sc'],set());vis.update(cue.get('s',[]));vis.difference_update(cue.get('x',[]))
                    original=art.select_one('svg[data-scene="'+step['sc']+'"]');diagram=BeautifulSoup(str(original),'xml').find('svg');pre=qid+'-'+step['sc']+'-'
                    for node in diagram.select('.lz'):
                        on=node.get('id','').removeprefix(pre) in vis
                        node['style']='opacity:'+('1' if on else '0')+';display:'+('inline' if on else 'none')
                        node['data-focus']=node.get('id','').removeprefix(pre)
                    svg,ids=svg_snapshot(str(diagram),cue.get('h',[]),attribute='data-focus')
                    if cue.get('k'):known.append(plain(cue['k']))
                    unit(q,si,ci,cue['t'],svg,ids,cue.get('f',''),cue.get('r',''),step['t'],step['sc'],facts=known)
    elif (data:=block(source,'problem-data')) is not None:
        for item in data:
            q=question(item['id'],str(item['number']),item['title']);q['conditions']=plain(item['conditions']);si=0
            first_graphic=next((st['diagram'] for m in item['methods'] for st in m['steps'] if '<svg' in st['diagram']),None)
            if first_graphic:
                svg,ids=svg_snapshot(first_graphic)
                paragraphs=BeautifulSoup(item['conditions'],'html.parser').find_all('p')
                for i,paragraph in enumerate(paragraphs):
                    text=plain(paragraph)
                    if re.match(r'^[①-⑳]|^\(?[1-9]\)',text):continue
                    intro_svg,intro_ids=svg_snapshot(numeric_diagram(text,'問題の条件'))
                    unit(q,-1-i,0,text,intro_svg,intro_ids,chapter='問題の条件を確認')
            for method in item['methods']:
                indices=[];previous='';generated=False
                for step in method['steps']:
                    body=BeautifulSoup(step['html'],'html.parser');table=body.find('table');eq=body.select_one('.equation')
                    dg=step['diagram'] or (str(table) if table else '') or (str(eq) if eq else '')
                    if dg:generated=False
                    elif previous and not generated:dg=previous
                    else:dg=numeric_diagram(step['html'],step['title']);generated=True
                    previous=dg;svg,ids=svg_snapshot(dg,step.get('focus',[]),attribute='data-focus')
                    unit(q,si,0,step['speech'] or plain(step['html']),svg,ids,speech=step['speech'],chapter=method['name']+'｜'+step['title'],reference=step['html']);indices.append(si);si+=1
                svg,ids=svg_snapshot(previous)
                unit(q,si,0,method['answer']+'。'+plain(method['check']),svg,ids,method['answer'],chapter=method['name']+'｜答えと元条件での検算');indices.append(si);si+=1
                q['chapters'].append({'label':method['name'],'steps':indices})
    elif 'const lessons=' in source:
        result['diagramContext']='visual'
        data=literal(source,'lessons')
        snapshot=ROOT/'automation/lecture-diagrams'/path.with_suffix('.json').name
        overrides=json.loads(snapshot.read_text(encoding='utf-8')) if snapshot.exists() else {}
        for qid,steps in data.items():
            art=soup.find(id=qid);q=question(qid,qid,plain(art.find(['h1','h2'])));q['conditions']=plain(art.select_one('.condition'));base=art.select_one('.visual svg') or art.find('svg')
            intro=re.split(r'[（(]1[）)]',q['conditions'])[0].strip()
            if intro:
                svg,ids=svg_snapshot(numeric_diagram(intro,'問題の条件と記号'));unit(q,-1,0,intro,svg,ids,chapter='問題の条件と記号')
            for si,step in enumerate(steps):
                dia=BeautifulSoup('<div>'+''.join(overrides[qid])+'</div>' if qid in overrides else str(base),'html.parser');focus=[]
                for i,node in enumerate(dia.select('.'+step['focus']) if step.get('focus') else []):node['data-focus']=str(i);focus.append(str(i))
                svg,ids=svg_snapshot(str(dia),focus,attribute='data-focus')
                section=art.select_one('.step[data-step="'+str(si)+'"]')
                paragraphs=section.find_all('p',recursive=False) if section else []
                for ci,text in enumerate([plain(p) for p in paragraphs] or [step['audio']]):
                    unit(q,si,ci,text,svg,ids,chapter=step['title'])
    elif 'const cues=' in source:
        cues=literal(source,'cues');figures=literal(source,'figures');groups={}
        for i,cue in enumerate(cues):
            qid='q'+str(cue['q'])
            if qid not in groups:groups[qid]=question(qid,str(cue['q']),'水そうとポンプ｜小問'+str(cue['q']))
            svg,ids=svg_snapshot(figures[cue['figure']],cue.get('focus',[]),attribute='data-focus')
            unit(groups[qid],i,0,cue.get('transcript') or cue['display'],svg,ids,cue.get('equation',''),cue.get('speech',''),cue['title'],cue['figure'])
    else:raise ValueError('Unknown lecture format: '+path.name)
    for q in result['questions']:
        if not q['chapters']:
            chapters={}
            for index in q['units']:
                u=result['units'][index];m=re.search(r'[（(](\d+)[）)]',u['title'])
                if m:chapters.setdefault('小問'+m[1],set()).add(u['stepIndex'])
            q['chapters']=[{'label':label,'steps':sorted(steps)} for label,steps in chapters.items()]
    return result

def inventory(out):
    out.mkdir(parents=True,exist_ok=True);items=[]
    for path in sorted((ROOT/'math').glob('*.html')):
        source=path.read_text(encoding='utf-8-sig')
        if not re.search(r'speechSynthesis|SpeechSynthesisUtterance|lectureBtn|lectureMode',source):continue
        data=extract(path);target=out/(path.stem+'.json');target.write_text(json.dumps(data,ensure_ascii=False),encoding='utf-8')
        items.append({'filename':path.name,'questions':len(data['questions']),'units':len(data['units']),'characters':sum(len(x['speechText']) for x in data['units'])})
        print(json.dumps(items[-1],ensure_ascii=False),flush=True)
    (out/'inventory.json').write_text(json.dumps(items,ensure_ascii=False,indent=2),encoding='utf-8')

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--extract',type=Path,required=True);args=parser.parse_args();inventory(args.extract)
