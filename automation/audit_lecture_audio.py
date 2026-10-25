"""PCM integrity checks. These measurements do not constitute listening."""
import argparse,array,audioop,hashlib,json,re,wave
from pathlib import Path
from synthesize_lectures import key,MODEL

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--data',type=Path,required=True);parser.add_argument('--tts',type=Path,required=True);parser.add_argument('--report',type=Path,required=True);args=parser.parse_args()
    texts={}
    for path in args.data.glob('*.json'):
        if path.name=='inventory.json':continue
        for unit in json.loads(path.read_text(encoding='utf-8'))['units']:texts[key(unit['speechText'])]=unit['speechText']
    rows=[];numeric_readings=0;punctuation_pauses=0
    for name,text in texts.items():
        path=args.tts/'cache'/(name+'.wav');meta=json.loads(path.with_suffix('.json').read_text(encoding='utf-8'));raw=path.read_bytes()
        assert hashlib.sha256(raw).hexdigest()==meta['sha256']
        assert meta['model']==MODEL and meta['speechText']==text
        plan=json.loads((args.tts/'cache'/(name+'.query.json')).read_text(encoding='utf-8'))
        expected_phrases=[{'reading':''.join(m['text'] for m in p['moras']),'accent':p['accent'],'pauseSeconds':p['pause_mora']['vowel_length'] if p['pause_mora'] else 0} for p in plan['query']['accent_phrases']]
        assert meta['phrases']==expected_phrases,(name,'Stale pronunciation/accent query')
        assert not re.search(r'\s',text),'Visual whitespace was passed to synthesis'
        spoken=''.join(p['reading'] for p in meta['phrases'])
        for quantity,(pronunciation,accent) in meta['dictionary'].items():
            if re.search(r'\d',quantity):
                assert pronunciation in spoken,(quantity,pronunciation,spoken)
                numeric_readings+=1
        marks=re.findall(r'[、。，！？!?]+',text.rstrip('、。，！？!?'))
        pauses=[p['pauseSeconds'] for p in meta['phrases'] if p['pauseSeconds']]
        assert len(marks)==len(pauses),(text,marks,pauses)
        for mark,pause in zip(marks,pauses):
            assert abs(pause-(.36 if re.search(r'[。！？!?]',mark) else .20))<1e-8
        punctuation_pauses+=len(pauses)
        with wave.open(str(path),'rb') as reader:
            assert (reader.getframerate(),reader.getnchannels(),reader.getsampwidth())==(24000,1,2)
            frames=reader.getnframes();pcm=reader.readframes(frames)
        assert frames==meta['frames'] and frames>2400 and len(pcm)==frames*2
        assert 0<=meta['speechStartFrame']<meta['speechEndFrame']<=frames
        rms=audioop.rms(pcm,2);peak=audioop.max(pcm,2);assert rms>30
        clipped=0
        if peak>=32767:
            samples=array.array('h',pcm);clipped=samples.count(32767)+samples.count(-32768)
        assert clipped/frames<=.001,(name,'clipping')
        rows.append({'hash':name,'sha256':meta['sha256'],'frames':frames,'seconds':frames/24000,'rms':rms,'peak':peak,'clippedSamples':clipped,'speechStartFrame':meta['speechStartFrame'],'speechEndFrame':meta['speechEndFrame']})
    result={'method':'PCM waveform/integrity and generated pronunciation/prosody data; not listening','uniqueClips':len(rows),'uniqueAudioSeconds':sum(r['seconds'] for r in rows),'rmsRange':[min(r['rms'] for r in rows),max(r['rms'] for r in rows)],'maxPeak':max(r['peak'] for r in rows),'clippedSamples':sum(r['clippedSamples'] for r in rows),'prosody':{'revision':MODEL['prosodyRevision'],'numericExpressionsChecked':numeric_readings,'numericReadingMismatches':0,'deliberatePunctuationPauses':punctuation_pauses,'unexpectedPauses':0},'clips':rows}
    args.report.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps({k:v for k,v in result.items() if k!='clips'},ensure_ascii=False))

if __name__=='__main__':main()
