"""Local-only VOICEVOX generation, with resumable content-addressed audio."""
import argparse, concurrent.futures, dataclasses, hashlib, io, json, math, os, re, struct, time, wave
from pathlib import Path

MODEL={'engine':'VOICEVOX CORE 0.17.1','model':'0.vvm 0.17.0','speaker':'四国めたん','style':2,'speed':0.97,'pitch':-0.025,'intonation':1.0,'samplingRate':24000,'prosodyRevision':'connected-quantities-20261025-v2'}
SYNTH=None
ANALYZER=None
VOICE_ANALYZER=None

NUMBER=r'\d+(?:\.\d+)?'
COUNTER=r'(?:平方センチメートル|立方センチメートル|平方センチ|立方センチ|平方メートル|立方メートル|ミリリットル|リットル|キロメートル|センチメートル|ミリメートル|メートル|センチ|キログラム|グラム|パーセント|時間|分間|秒間|日間|か月|ヶ月|目盛り|通り|ふん|分(?!の)|秒|日|年|歳|才|人|個|台|枚|本|組|回|段|列|行|番|つ|倍|桁|辺|面|冊|円|点|度|種類|区間|の位)'
QUANTITY=re.compile(NUMBER+r'(?:分の'+NUMBER+r')?(?:'+COUNTER+r')?')
LETTER_NAMES=['エー','ビー','シー','ディー','イー','エフ','ジー','エイチ','アイ','ジェー','ケー','エル','エム','エヌ','オー','ピー','キュー','アール','エス','ティー','ユー','ブイ','ダブリュー','エックス','ワイ','ゼット']
LETTERS=re.compile('(?:'+'|'.join(sorted(LETTER_NAMES,key=len,reverse=True))+')+')
POINT_PREFIXES=('チョオテン','テン','サンカッケエ','シカッケエ','ゴカッケエ','ロッカッケエ','セエホオケエ','チョオホオケエ','ヘン','テエヘン','タイカクセン','センブン','チョクセン','カク','メン','テエメン','ソクメン','ジョオメン','カメン','キリクチ','エン','チュウシン','コオテン','チュウテン')

def reading(phrases):
    return ''.join(m.text for p in phrases for m in p.moras)

def joined_accent(phrases):
    """Retain the last lexical nucleus; a flat final word stays flat.

    Treat the complete numerical quantity as one dictionary word rather than
    resetting pitch separately for its digits and counter.
    """
    last=phrases[-1]
    if last.accent==len(last.moras):return 0
    return sum(len(p.moras) for p in phrases[:-1])+last.accent

def dictionary_entries(text,analyzer):
    terms={'一の位':('イチノクライ',4),'十の位':('ジュウノクライ',4),'百の位':('ヒャクノクライ',4),'1の位':('イチノクライ',4),'10の位':('ジュウノクライ',4),'100の位':('ヒャクノクライ',4),'辺':('ヘン',1)}
    entries={surface:value for surface,value in terms.items() if surface in text}
    for match in QUANTITY.finditer(text):
        surface=match[0]
        if '分の' in surface:
            denominator,numerator=surface.split('分の',1)
            left=analyzer.analyze(denominator)
            right=analyzer.analyze(numerator.replace('ふん','分'))
            pronunciation=reading(left)+'ブンノ'+reading(right)
            accent=0 if joined_accent(right)==0 else sum(len(p.moras) for p in left)+3+joined_accent(right)
        else:
            phrases=analyzer.analyze(surface.replace('ふん','分'))
            pronunciation=reading(phrases);accent=joined_accent(phrases)
        if surface=='1目盛り':pronunciation='ヒトメモリ';accent=3
        if surface=='1組':pronunciation='ヒトクミ';accent=2
        if surface in terms:pronunciation,accent=terms[surface]
        if re.fullmatch(r'0\d+',surface):
            digits=['ゼロ','イチ','ニ','サン','ヨン','ゴ','ロク','ナナ','ハチ','キュウ']
            pronunciation=''.join(digits[int(c)] for c in surface);accent=0
        # Always register the entire numeric token. A shorter entry from another
        # expression must not split a decimal or a longer number into fragments.
        entries[surface]=(pronunciation,accent)
    for match in LETTERS.finditer(text):
        surface=match[0]
        names=re.findall('|'.join(sorted(LETTER_NAMES,key=len,reverse=True)),surface)
        # A letter sequence denotes one segment/triangle. Its particle is then
        # analyzed together with that noun; no commas are inserted between names.
        pronunciation=''.join(names)
        # Each letter's own common accent is retained for single names. For
        # compound point names the final letter carries the lexical nucleus.
        final=analyzer.analyze(names[-1]);prefix=sum(len(p.moras) for p in analyzer.analyze(''.join(names[:-1]))) if len(names)>1 else 0
        accent=prefix+1 if final else 1
        entries[surface]=(pronunciation,accent)
    return entries

def prepare_synthesis_text(text,entries):
    """Use exact dictionary tokens, avoiding Open JTalk's digit normalization.

    Registering literal decimal strings is insufficient: a shorter integer entry
    elsewhere in the same text can split a decimal at its dot. These internal
    noun tokens carry the *whole* quantity's reading and accent. The natural
    mixed-script speechText is retained separately and never replaced in print.
    """
    dictionary={k:v for k,v in entries.items() if not re.search(r'\d',k)}
    tokens={}
    def replace(match):
        source=match[0]
        if source not in tokens:
            # Stable all-kanji labels contain no mathematical punctuation/digits.
            n=len(tokens);code=''
            while True:
                code=chr(0x4e00+n%128)+code;n=n//128-1
                if n<0:break
            tokens[source]='講義数量'+code
            dictionary[tokens[source]]=entries[source]
        return tokens[source]
    return QUANTITY.sub(replace,text),dictionary

def adjust_point_accents(query,entries):
    """Keep a point name's lexical nucleus after a mathematical descriptor.

    Open JTalk's compound rules can overwrite a user-dictionary accent with the
    descriptor's accent (e.g. 頂点F, 三角形ADF). Relocate the registered nucleus
    to its actual mora position in that phrase and predict pitch again. No pause
    or extra utterance is inserted between the Japanese word and the point name.
    """
    words=[]
    for surface,(pronunciation,accent) in entries.items():
        if LETTERS.fullmatch(surface):
            moras=[m.text for p in VOICE_ANALYZER.analyze(surface) for m in p.moras]
            words.append((moras,accent,surface))
    edits=[]
    for phrase in query.accent_phrases:
        values=[m.text for m in phrase.moras];used_starts=set()
        for word,accent,surface in sorted(words,key=lambda x:len(x[0]),reverse=True):
            for start in range(1,len(values)-len(word)+1):
                if start in used_starts:continue
                if values[start:start+len(word)]!=word:continue
                prefix=''.join(values[:start])
                if not prefix.endswith(POINT_PREFIXES):continue
                used_starts.add(start)
                target=start+accent if accent else len(values)
                if phrase.accent!=target:
                    edits.append({'phrase':reading([phrase]),'point':surface,'from':phrase.accent,'to':target});phrase.accent=target
    if edits:
        query.accent_phrases=SYNTH.replace_mora_pitch(query.accent_phrases,MODEL['style'])
        # The original kana string describes the frontend's pre-edit accents.
        query.kana=None
    query._lecture_accent_corrections=edits
    return edits

def query_with_prosody(text):
    from voicevox_core import UserDictWord, Mora, AudioQuery
    from voicevox_core.blocking import UserDict
    if re.search(r'\s',text):raise ValueError('Visual whitespace must not enter speech synthesis')
    entries=dictionary_entries(text,ANALYZER);prepared,prepared_entries=prepare_synthesis_text(text,entries);dictionary=UserDict()
    for surface,(pronunciation,accent) in prepared_entries.items():
        dictionary.add_word(UserDictWord(surface=surface,pronunciation=pronunciation,accent_type=accent,priority=9))
    VOICE_ANALYZER.use_user_dict(dictionary)
    q=SYNTH.create_audio_query(prepared,MODEL['style'])
    if 'コオギスウリョオ' in reading(q.accent_phrases):raise ValueError('A quantity dictionary token was not applied')
    # Only deliberate sentence/list punctuation may produce silence. Dictionary
    # compounds control quantity accents; particles remain in the same context.
    marks=re.findall(r'[、。，！？!?]+',text.rstrip('、。，！？!?'))
    pauses=[p for p in q.accent_phrases if p.pause_mora is not None]
    if len(marks)!=len(pauses):
        # Rarely Open JTalk drops a written sentence/comma boundary. Analyze only
        # those deliberate clauses separately, then predict pitch/length for the
        # combined sequence and synthesize the complete unit in ONE operation.
        parts=re.split(r'([、。，！？!?]+)',prepared);phrases=[]
        for i in range(0,len(parts),2):
            if not parts[i]:continue
            clause=VOICE_ANALYZER.analyze(parts[i])
            if any(p.pause_mora for p in clause):raise ValueError('Unexpected pause inside a punctuation-free clause: '+text)
            mark=parts[i+1] if i+1<len(parts) else ''
            following=any(parts[j] for j in range(i+2,len(parts),2))
            if mark and following:clause[-1].pause_mora=Mora(text='、',consonant=None,consonant_length=None,vowel='pau',vowel_length=.2,pitch=0)
            if re.search(r'[？?]',mark):clause[-1].is_interrogative=True
            phrases.extend(clause)
        q=AudioQuery.from_accent_phrases(SYNTH.replace_mora_data(phrases,MODEL['style']))
        pauses=[p for p in q.accent_phrases if p.pause_mora is not None]
        if len(marks)!=len(pauses):raise ValueError('Punctuation alignment failed: '+text)
    adjust_point_accents(q,entries)
    pauses=[p for p in q.accent_phrases if p.pause_mora is not None]
    for phrase,mark in zip(pauses,marks):
        if isinstance(phrase.pause_mora,dict):phrase.pause_mora=Mora(**phrase.pause_mora)
        phrase.pause_mora.vowel_length=.36 if re.search(r'[。！？!?]',mark) else .20
    q.pre_phoneme_length=.055;q.post_phoneme_length=.08
    q.speed_scale=MODEL['speed'];q.pitch_scale=MODEL['pitch'];q.intonation_scale=MODEL['intonation'];q.output_sampling_rate=24000;q.output_stereo=False
    return q,entries

def query_to_dict(query):return dataclasses.asdict(query)

def query_from_dict(data):
    from voicevox_core import AudioQuery,AccentPhrase,Mora
    data=dict(data);phrases=[]
    for original in data['accent_phrases']:
        phrase=dict(original);phrase['moras']=[Mora(**m) for m in phrase['moras']]
        if phrase.get('pause_mora'):phrase['pause_mora']=Mora(**phrase['pause_mora'])
        phrases.append(AccentPhrase(**phrase))
    data['accent_phrases']=phrases
    return AudioQuery(**data)

def key(text):return hashlib.sha256(json.dumps([MODEL,text],ensure_ascii=False,sort_keys=True).encode()).hexdigest()

def init(root):
    global SYNTH,ANALYZER,VOICE_ANALYZER
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
    ANALYZER=OpenJtalk(str(root/'open_jtalk_dic_utf_8-1.11'))
    VOICE_ANALYZER=OpenJtalk(str(root/'open_jtalk_dic_utf_8-1.11'))
    SYNTH=Synthesizer(ort,VOICE_ANALYZER,acceleration_mode='CPU',cpu_num_threads=2)
    with VoiceModelFile.open(str(root/'0.vvm')) as model:SYNTH.load_voice_model(model)

def _generate_unlocked(job):
    text,cache=job;cache=Path(cache);name=key(text);wav=cache/(name+'.wav');meta=cache/(name+'.json')
    if wav.exists() and meta.exists():return name,False
    planned=cache/(name+'.query.json')
    if planned.exists():
        plan=json.loads(planned.read_text(encoding='utf-8'))
        assert plan['speechText']==text and plan['model']==MODEL
        q=query_from_dict(plan['query']);entries=plan['dictionary']
    else:q,entries=query_with_prosody(text)
    raw=SYNTH.synthesis(q,MODEL['style'])
    with wave.open(io.BytesIO(raw)) as audio:
        assert audio.getframerate()==24000 and audio.getnchannels()==1 and audio.getsampwidth()==2
        frames=audio.getnframes();pcm=audio.readframes(frames)
    samples=struct.unpack('<'+'h'*(len(pcm)//2),pcm)
    rms=math.sqrt(sum(v*v for v in samples)/len(samples))
    if frames<2400 or rms<30:raise ValueError('Empty or silent generated audio: '+name)
    last=next(i for i in range(len(samples)-1,-1,-1) if abs(samples[i])>24)
    first=next(i for i,v in enumerate(samples) if abs(v)>24)
    data={'hash':name,'model':MODEL,'speechText':text,'kana':q.kana,'dictionary':entries,'phrases':[{'reading':reading([p]),'accent':p.accent,'pauseSeconds':p.pause_mora.vowel_length if p.pause_mora else 0} for p in q.accent_phrases],'frames':frames,'speechStartFrame':first,'speechEndFrame':last+1,'rms':round(rms,2),'sha256':hashlib.sha256(raw).hexdigest()}
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
