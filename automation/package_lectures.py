"""Measure PCM boundaries, encode once, verify decoding, embed self-contained HTML."""
import argparse, base64, hashlib, json, re, subprocess, wave
from pathlib import Path
import imageio_ffmpeg
from synthesize_lectures import key, MODEL

ROOT=Path(__file__).resolve().parents[1]

def encode(track,bitrate=64):
    ffmpeg=imageio_ffmpeg.get_ffmpeg_exe();mp3=track.with_suffix('.mp3')
    subprocess.run([ffmpeg,'-v','error','-y','-i',str(track),'-c:a','libmp3lame','-b:a',str(bitrate)+'k','-ar','24000','-ac','1','-write_xing','1',str(mp3)],check=True)
    decoded=track.with_suffix('.decoded.wav')
    subprocess.run([ffmpeg,'-v','error','-y','-i',str(mp3),'-c:a','pcm_s16le',str(decoded)],check=True)
    with wave.open(str(decoded),'rb') as reader:encoded_duration=reader.getnframes()/reader.getframerate()
    with wave.open(str(track),'rb') as reader:pcm_duration=reader.getnframes()/reader.getframerate()
    assert abs(encoded_duration-pcm_duration)<=0.025,(encoded_duration,pcm_duration)
    return mp3,{'model':MODEL,'duration':encoded_duration,'bytes':mp3.stat().st_size,'sha256':hashlib.sha256(mp3.read_bytes()).hexdigest(),'gapSeconds':.5,'format':f'MP3 mono 24kHz {bitrate}kbps'}

def assemble(units,cache,out,name):
    track=out/(name+'.wav');rate=24000;position=0;gap=b'\0'*(12000*2)
    with wave.open(str(track),'wb') as writer:
        writer.setnchannels(1);writer.setsampwidth(2);writer.setframerate(rate)
        for unit in units:
            name=key(unit['speechText']);meta=json.loads((cache/(name+'.json')).read_text(encoding='utf-8'))
            raw=(cache/(name+'.wav')).read_bytes()
            assert hashlib.sha256(raw).hexdigest()==meta['sha256']
            with wave.open(str(cache/(name+'.wav')),'rb') as reader:
                frames=reader.getnframes();assert frames==meta['frames'];pcm=reader.readframes(frames)
            unit.update(start=position/rate,speechEnd=(position+meta['speechEndFrame'])/rate,end=(position+frames+12000)/rate,audioHash=meta['sha256'])
            writer.writeframes(pcm);writer.writeframes(gap);position+=frames+12000
    return encode(track)

def reuse_audio(data,out,cache):
    """UI/diagram-only rebuilds retain already measured and verified MP3s."""
    path=out/(data['filename']+'.timing.json')
    if not path.exists():return None
    previous=json.loads(path.read_text(encoding='utf-8'))
    if previous.get('audio',{}).get('model')!=MODEL or len(previous['units'])!=len(data['units']):return None
    if [(q['id'],q['units']) for q in previous['questions']]!=[(q['id'],q['units']) for q in data['questions']]:return None
    fields=['start','speechEnd','end','audioHash','audioId']
    for old,unit in zip(previous['units'],data['units']):
        if old['id']!=unit['id'] or old['speechText']!=unit['speechText']:return None
        meta=json.loads((cache/(key(unit['speechText'])+'.json')).read_text(encoding='utf-8'))
        if meta['sha256']!=old['audioHash'] or any(field not in old for field in fields):return None
    audios={}
    for old,q in zip(previous['questions'],data['questions']):
        mp3=out/(data['filename']+'--'+q['id']+'.mp3')
        if not mp3.exists() or hashlib.sha256(mp3.read_bytes()).hexdigest()!=old['audio']['sha256']:return None
        audios[q['id']]=mp3
    for old,unit in zip(previous['units'],data['units']):
        for field in fields:unit[field]=old[field]
    for old,q in zip(previous['questions'],data['questions']):q['audio']=old['audio']
    return audios

def embed(source,data,audios,runtime):
    # Legacy readers, diagrams, print handlers and normal explanations remain.
    # Their old speech synthesizer is disabled; the recorded player owns lectures.
    source=re.sub(r'<script[^>]*id="recorded-lecture-(?:data|audio-source[^"]*|runtime)"[^>]*>.*?</script>\s*','',source,flags=re.S)
    source=re.sub(r'<style id="recorded-lecture-layout">.*?</style>\s*','',source,flags=re.S)
    source=source.replace('window.speechSynthesis','null').replace('selectLesson(b.dataset.lesson,true)','selectLesson(b.dataset.lesson,false)')
    data['legacyLectureOnly']='2026年7月号_比のあつかいと文章題_講義' in data['filename']
    payload=json.dumps(data,ensure_ascii=False,separators=(',',':')).replace('</','<\\/')
    addition='<style id="recorded-lecture-layout">@media screen{.reader-topbar{flex-wrap:wrap}}@media print{body{overflow:visible!important;height:auto!important}#recorded-lecture-host{display:none!important}}</style>\n'
    addition+='<script id="recorded-lecture-data" type="application/json">'+payload+'</script>\n'
    for question in data['questions']:
        encoded=base64.b64encode(audios[question['id']].read_bytes()).decode('ascii')
        addition+='<script id="recorded-lecture-audio-source--'+question['id']+'" type="application/octet-stream">data:audio/mpeg;base64,'+encoded+'</script>\n'
    addition+='<script id="recorded-lecture-runtime">'+runtime.replace('</script','<\\/script')+'</script>\n'
    if '</body>' not in source:raise ValueError('No body end')
    result=source.replace('</body>',addition+'</body>')
    for question in data['questions']:
        embedded=re.search(r'<script id="recorded-lecture-audio-source--'+re.escape(question['id'])+'"[^>]*>data:audio/mpeg;base64,(.*?)</script>',result,re.S)[1]
        assert hashlib.sha256(base64.b64decode(embedded)).hexdigest()==question['audio']['sha256']
    return result

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--data',type=Path,required=True);parser.add_argument('--tts',type=Path,required=True);parser.add_argument('--out',type=Path,required=True);parser.add_argument('--only');parser.add_argument('--first-question',action='store_true');args=parser.parse_args()
    args.out.mkdir(exist_ok=True,parents=True);runtime=(ROOT/'automation/renderer/recorded-lecture.js').read_text(encoding='utf-8');report=[]
    for path in sorted(args.data.glob('*.json')):
        if path.name=='inventory.json' or (args.only and args.only not in path.stem and args.only!=path.stem+'.html'):continue
        data=json.loads(path.read_text(encoding='utf-8'))
        if args.first_question:
            data['questions']=data['questions'][:1];data['units']=[data['units'][i] for i in data['questions'][0]['units']]
        audios=reuse_audio(data,args.out,args.tts/'cache')
        if audios is None:
            audios={}
            for question in data['questions']:
                units=[data['units'][i] for i in question['units']]
                for unit in units:unit['audioId']=question['id']
                mp3,meta=assemble(units,args.tts/'cache',args.out,data['filename']+'--'+question['id']);audios[question['id']]=mp3;question['audio']=meta
        original=(ROOT/'math'/data['filename']).read_text(encoding='utf-8-sig')
        for bitrate in [64,56,48]:
            if bitrate!=64:
                for question in data['questions']:
                    mp3,meta=encode(audios[question['id']].with_suffix('.wav'),bitrate);audios[question['id']]=mp3;question['audio']=meta
            data['audio']={'model':MODEL,'duration':sum(q['audio']['duration'] for q in data['questions']),'manifestSha256':hashlib.sha256(''.join(q['audio']['sha256'] for q in data['questions']).encode()).hexdigest()}
            html=embed(original,data,audios,runtime)
            if len(html.encode('utf-8'))<=90*1024*1024:break
        else:raise ValueError('Standalone lesson exceeds verified publishing limit: '+data['filename'])
        output=args.out/data['filename'];output.write_text(html,encoding='utf-8',newline='\n')
        item={'filename':data['filename'],'units':len(data['units']),'duration':data['audio']['duration'],'audioManifestSha256':data['audio']['manifestSha256'],'htmlBytes':output.stat().st_size};report.append(item);print(json.dumps(item,ensure_ascii=False),flush=True)
        (args.out/(data['filename']+'.timing.json')).write_text(json.dumps(data,ensure_ascii=False),encoding='utf-8')
    (args.out/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')

if __name__=='__main__':main()
