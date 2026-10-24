"""Local-only VOICEVOX generation, with resumable content-addressed audio."""
import argparse, concurrent.futures, hashlib, io, json, math, os, struct, time, wave
from pathlib import Path

MODEL={'engine':'VOICEVOX CORE 0.17.1','model':'0.vvm 0.17.0','speaker':'四国めたん','style':2,'speed':0.97,'pitch':-0.025,'intonation':1.0,'samplingRate':24000}
SYNTH=None

def key(text):return hashlib.sha256(json.dumps([MODEL,text],ensure_ascii=False,sort_keys=True).encode()).hexdigest()

def init(root):
    global SYNTH
    if os.name=='nt':
        # Leave interactive playback and editing responsive during long builds.
        import ctypes
        kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        kernel.GetCurrentProcess.restype=ctypes.c_void_p
        kernel.SetPriorityClass.argtypes=[ctypes.c_void_p,ctypes.c_uint32]
        kernel.SetPriorityClass(kernel.GetCurrentProcess(),0x4000)
    from voicevox_core.blocking import Onnxruntime,OpenJtalk,Synthesizer,VoiceModelFile
    root=Path(root)
    ort=Onnxruntime.load_once(filename=str(root/'voicevox_onnxruntime-win-x64-1.17.3/lib/voicevox_onnxruntime.dll'))
    SYNTH=Synthesizer(ort,OpenJtalk(str(root/'open_jtalk_dic_utf_8-1.11')),acceleration_mode='CPU',cpu_num_threads=3)
    with VoiceModelFile.open(str(root/'0.vvm')) as model:SYNTH.load_voice_model(model)

def _generate_unlocked(job):
    text,cache=job;cache=Path(cache);name=key(text);wav=cache/(name+'.wav');meta=cache/(name+'.json')
    if wav.exists() and meta.exists():return name,False
    q=SYNTH.create_audio_query(text,MODEL['style']);q.speed_scale=MODEL['speed'];q.pitch_scale=MODEL['pitch'];q.intonation_scale=MODEL['intonation'];q.output_sampling_rate=24000;q.output_stereo=False
    raw=SYNTH.synthesis(q,MODEL['style'])
    with wave.open(io.BytesIO(raw)) as audio:
        assert audio.getframerate()==24000 and audio.getnchannels()==1 and audio.getsampwidth()==2
        frames=audio.getnframes();pcm=audio.readframes(frames)
    samples=struct.unpack('<'+'h'*(len(pcm)//2),pcm)
    rms=math.sqrt(sum(v*v for v in samples)/len(samples))
    if frames<2400 or rms<30:raise ValueError('Empty or silent generated audio: '+name)
    last=next(i for i in range(len(samples)-1,-1,-1) if abs(samples[i])>24)
    data={'hash':name,'model':MODEL,'speechText':text,'kana':q.kana,'frames':frames,'speechEndFrame':last+1,'rms':round(rms,2),'sha256':hashlib.sha256(raw).hexdigest()}
    tmp=wav.with_suffix('.'+str(os.getpid())+'.tmp');tmp.write_bytes(raw);tmp.replace(wav)
    meta_tmp=meta.with_suffix('.'+str(os.getpid())+'.tmp');meta_tmp.write_text(json.dumps(data,ensure_ascii=False),encoding='utf-8');meta_tmp.replace(meta)
    return name,True

def generate(job):
    text,cache=job;cache=Path(cache);name=key(text);lock=cache/(name+'.lock')
    while True:
        if (cache/(name+'.wav')).exists() and (cache/(name+'.json')).exists():return name,False
        try:handle=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY)
        except FileExistsError:
            try:
                if time.time()-lock.stat().st_mtime>600:lock.unlink(missing_ok=True)
            except FileNotFoundError:pass
            time.sleep(.2);continue
        try:return _generate_unlocked(job)
        finally:os.close(handle);lock.unlink(missing_ok=True)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--data',type=Path,required=True);parser.add_argument('--tts',type=Path,required=True);parser.add_argument('--workers',type=int,default=4);parser.add_argument('--only');args=parser.parse_args()
    cache=args.tts/'cache';cache.mkdir(exist_ok=True);texts={}
    for p in args.data.glob('*.json'):
        if p.name=='inventory.json' or (args.only and args.only not in p.stem):continue
        for u in json.loads(p.read_text(encoding='utf-8'))['units']:texts[key(u['speechText'])]=u['speechText']
    missing=[text for k,text in texts.items() if not (cache/(k+'.json')).exists()]
    print(json.dumps({'totalUnique':len(texts),'cached':len(texts)-len(missing),'remaining':len(missing)},ensure_ascii=False),flush=True)
    begun=time.time()
    with concurrent.futures.ProcessPoolExecutor(max_workers=args.workers,initializer=init,initargs=(str(args.tts.resolve()),)) as pool:
        futures=[pool.submit(generate,(text,str(cache.resolve()))) for text in missing]
        for i,future in enumerate(concurrent.futures.as_completed(futures),1):
            future.result()
            if i%10==0 or i==len(missing):print(json.dumps({'complete':i,'remaining':len(missing)-i,'elapsedSeconds':round(time.time()-begun)}),flush=True)
    print('Local synthesis complete.',flush=True)

if __name__=='__main__':main()
