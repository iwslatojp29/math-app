"""PCM integrity checks. These measurements do not constitute listening."""
import argparse,array,audioop,hashlib,json,wave
from pathlib import Path
from synthesize_lectures import key

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--data',type=Path,required=True);parser.add_argument('--tts',type=Path,required=True);parser.add_argument('--report',type=Path,required=True);args=parser.parse_args()
    texts={}
    for path in args.data.glob('*.json'):
        if path.name=='inventory.json':continue
        for unit in json.loads(path.read_text(encoding='utf-8'))['units']:texts[key(unit['speechText'])]=unit['speechText']
    rows=[]
    for name,text in texts.items():
        path=args.tts/'cache'/(name+'.wav');meta=json.loads(path.with_suffix('.json').read_text(encoding='utf-8'));raw=path.read_bytes()
        assert hashlib.sha256(raw).hexdigest()==meta['sha256']
        with wave.open(str(path),'rb') as reader:
            assert (reader.getframerate(),reader.getnchannels(),reader.getsampwidth())==(24000,1,2)
            frames=reader.getnframes();pcm=reader.readframes(frames)
        assert frames==meta['frames'] and frames>2400 and len(pcm)==frames*2
        rms=audioop.rms(pcm,2);peak=audioop.max(pcm,2);assert rms>30
        clipped=0
        if peak>=32767:
            samples=array.array('h',pcm);clipped=samples.count(32767)+samples.count(-32768)
        assert clipped/frames<=.001,(name,'clipping')
        rows.append({'hash':name,'sha256':meta['sha256'],'frames':frames,'seconds':frames/24000,'rms':rms,'peak':peak,'clippedSamples':clipped,'speechEndFrame':meta['speechEndFrame']})
    result={'method':'PCM waveform/integrity; not listening','uniqueClips':len(rows),'uniqueAudioSeconds':sum(r['seconds'] for r in rows),'rmsRange':[min(r['rms'] for r in rows),max(r['rms'] for r in rows)],'maxPeak':max(r['peak'] for r in rows),'clippedSamples':sum(r['clippedSamples'] for r in rows),'clips':rows}
    args.report.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps({k:v for k,v in result.items() if k!='clips'},ensure_ascii=False))

if __name__=='__main__':main()
