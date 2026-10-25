import importlib.util,json,re,sys,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('recorded_lectures',ROOT/'automation/recorded_lectures.py')
builder=importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)

class PronunciationTests(unittest.TestCase):
    def test_time_and_fraction_are_distinct(self):
        self.assertEqual(builder.spoken('3分後、3分の1'), '3分後、3分の1')
        self.assertEqual(builder.spoken('1分、4分、10分、12分、20分'), '1分、4分、10分、12分、20分')
        self.assertEqual(builder.spoken('1.5分'), '1.5分')
        self.assertEqual(builder.spoken('3/4分'), '4分の3ふん')
        self.assertEqual(builder.spoken('67分の5/3倍'), '67ふんの3分の5倍')
        self.assertEqual(builder.spoken('4分は12分の3分の1です。'),'4分は12ふんの3分の1です。')
    def test_denominators_units_and_water_context(self):
        self.assertEqual(builder.spoken('5/4'), '4分の5')
        self.assertEqual(builder.spoken('毎分2L入り、12cm²で、8cm³の水が空になる。'), '毎分2リットル入り、12平方センチメートルで、8立方センチメートルの水がからっぽになる。')
        self.assertIn('シー対ディーは2対3',builder.spoken('C：D＝2：3'))
    def test_audio_script_remains_mixed_natural_japanese(self):
        text=builder.spoken('緑の休み時間を見てください。10分動いたあと、5分休みます。')
        self.assertIn('緑の休み時間',text);self.assertIn('10分',text)
    def test_quantity_letter_and_particle_have_no_visual_whitespace(self):
        self.assertEqual(builder.spoken('C は 5 分の 1 を渡し、8 L です。'),'シーは5分の1を渡し、8リットルです。')
        self.assertEqual(builder.spoken('辺 AB の長さは 12 cm。'),'辺エービーの長さは12センチメートル。')
        self.assertEqual(builder.spoken('A・B・Cを比べます。'),'エーとビーとシーを比べます。')
        self.assertEqual(builder.spoken('合計は2＋3×3＝11個です。'),'合計は2たす3かける3で11個です。')
    def test_heading_colon_is_distinct_from_ratio(self):
        self.assertEqual(builder.spoken('条件1：どの位にも0を使わない。'),'条件1は、どの位にも0を使わない。')
        self.assertEqual(builder.spoken('面積840：1120の逆。'),'面積840対1120の逆。')
    def test_length_mass_and_speed_units_are_not_variable_names(self):
        self.assertEqual(builder.spoken('5m、300 g、2kg、80m/分、7.2kmをmにそろえる。'),'5メートル、300グラム、2キログラム、毎分80メートル、7.2キロメートルをメートルにそろえる。')
    def test_problem_specific_symbols_keep_their_declared_meaning(self):
        text,notes=builder.pronunciation_plan('A↓は1からAまでの積です。6↓＝720。','2026年11月号_整数_解答解説・アニメーション.html','d13')
        self.assertIn('エーの下向き矢印',text);self.assertIn('1から6までの積',text);self.assertTrue(notes)
        text,notes=builder.pronunciation_plan('9[886]を887で割る。','2026年11月号_発展演習・学力コンテスト_思考力を育てる解説.html','d4')
        self.assertIn('9が886個並ぶ数',text)
        text,notes=builder.pronunciation_plan('和子が英子宅に着く。','2026年9月号_速さと比_解答解説・アニメーション.html','d02')
        self.assertEqual(text,'かずこがえいこの家に着く。');self.assertTrue(notes)
    def test_comparisons_are_explanations_not_symbol_names(self):
        text=builder.spoken('B＞C≥2なので、n≦15という条件です。')
        self.assertIn('ビーはシーより大きく、シーは2以上',text);self.assertIn('エヌは15以下',text)
    def test_geometry_snapshot_keeps_real_targets_and_overlay(self):
        source='<svg xmlns="http://www.w3.org/2000/svg"><line data-node="3" x1="0" x2="10"/><text data-node="4">A</text></svg>'
        markup,ids=builder.svg_snapshot(source,[3],[4],'<circle cx="2" cy="2" r="1"/>','data-node')
        self.assertEqual(len(ids),2);self.assertIn('display:none',markup);self.assertIn('recorded-focus',markup)
    def test_two_diagrams_are_not_reduced_to_one(self):
        markup,ids=builder.svg_snapshot('<div><svg xmlns="http://www.w3.org/2000/svg"><text>A</text></svg><svg xmlns="http://www.w3.org/2000/svg"><text>B</text></svg></div>')
        self.assertEqual(markup.count('<svg'),2)
    def test_number_diagrams_only_use_source_quantities(self):
        markup=builder.numeric_diagram('823×12＝9876です。','分母を12にする')
        self.assertIn('823×12＝9876',markup);self.assertNotIn('9999',markup)
    def test_long_reasoning_is_split_only_at_complete_sentences(self):
        text=('図の同じ区間を比べると、長さの比が分かります。'*4)+('この比を用いて面積を計算します。'*6)
        chunks=builder.semantic_chunks(text)
        self.assertGreater(len(chunks),1);self.assertEqual(''.join(chunks),text)
        self.assertTrue(all(part.endswith('。') for part in chunks))

class ProsodyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        runtime=ROOT.parent/'lecture-tts'
        if not (runtime/'0.vvm').exists():raise unittest.SkipTest('Local VOICEVOX runtime is required for prosody integration checks.')
        sys.path.insert(0,str(ROOT/'automation'))
        import synthesize_lectures
        cls.synth=synthesize_lectures;cls.synth.init(runtime)
    def query(self,text):return self.synth.query_with_prosody(builder.spoken(text))[0]
    def test_fraction_and_particles_remain_connected(self):
        query=self.query('C は 5 分の 1 を渡し、残りの 5 分の 4 が 8 L です。')
        phrases=query.accent_phrases
        self.assertEqual(sum(p.pause_mora is not None for p in phrases),1)
        readings=[self.synth.reading([p]) for p in phrases]
        self.assertIn('シイワ',readings);self.assertIn('ゴブンノイチオ',readings)
        self.assertIn('ハチリットルデス',readings)
        self.assertTrue(any(r.endswith('ヨンガ') for r in readings))
    def test_complete_time_quantity_keeps_its_particle(self):
        query=self.query('12分なら、4分で、10分後です。')
        readings=[self.synth.reading([p]) for p in query.accent_phrases]
        self.assertIn('ジュウニフンナラ',readings);self.assertIn('ヨンプンデ',readings)
        self.assertTrue(any(r.startswith('ジュップン') for r in readings))
        nested=self.query('4分は12分の3分の1です。')
        self.assertIn('ジュウニフンノ',self.synth.reading(nested.accent_phrases))
        self.assertNotIn('ジュウニブン',self.synth.reading(nested.accent_phrases))
    def test_decimal_survives_other_integer_dictionary_entries(self):
        query=self.query('1個と4個。3.14cmと4.71cmを足し、35.4cmです。')
        readings=[self.synth.reading([p]) for p in query.accent_phrases]
        self.assertTrue(any('サンテンイチヨンセンチメートル' in r.replace('エ','ー') or 'サンテンイチヨンセンチメエトル' in r for r in readings),readings)
        self.assertEqual(sum(p.pause_mora is not None for p in query.accent_phrases),2)
        self.assertNotIn('コオギスウリョオ',''.join(readings))
    def test_point_sequence_has_no_internal_pause(self):
        query=self.query('辺ABの長さは12cmです。三角形ADFとBDFを比べます。')
        self.assertEqual(sum(p.pause_mora is not None for p in query.accent_phrases),1)
        self.assertIn('エエビイノ',self.synth.reading(query.accent_phrases))
    def test_descriptor_does_not_overwrite_point_name_accent(self):
        query=self.query('頂点Fから、三角形ADFとBDFを比べます。Aは別の点です。')
        phrases={self.synth.reading([p]):p.accent for p in query.accent_phrases}
        self.assertEqual(phrases['チョオテンエフカラ'],5)
        self.assertEqual(phrases['サンカッケエエエディイエフト'],11)
        self.assertEqual(sum(p.pause_mora is not None for p in query.accent_phrases),2)
    def test_pause_lengths_and_query_round_trip(self):
        query=self.query('Aは3個です。Bは4個で、合計7個です。')
        pauses=[p.pause_mora.vowel_length for p in query.accent_phrases if p.pause_mora]
        self.assertEqual(pauses,[.36,.20])
        restored=self.synth.query_from_dict(self.synth.query_to_dict(query))
        restored.validate()
        self.assertEqual(self.synth.query_to_dict(query),self.synth.query_to_dict(restored))
    def test_analyzer_dropped_boundary_is_restored_before_synthesis(self):
        query=self.query('Cまでの1区間は赤が14−3＝11個多く、Cの後は青が11個多くなります。前後の区間を1個ずつ組にすると、差は打ち消し合います。')
        self.assertEqual([p.pause_mora.vowel_length for p in query.accent_phrases if p.pause_mora],[.20,.36,.20])
        query.validate()
    def test_subquestion_label_does_not_merge_into_next_number(self):
        self.assertEqual(builder.spoken('（2）1から9の数字です。'),'小問2では、1から9の数字です。')
        self.assertEqual(builder.spoken('100/3m/分、228と4/7m/分。'),'毎分3分の100メートル、毎分228と7分の4メートル。')

class PublishedLectureTests(unittest.TestCase):
    def test_all_converted_pages_have_complete_audio_timing_and_valid_focus_targets(self):
        import base64,hashlib
        from bs4 import BeautifulSoup
        found=0
        for path in (ROOT/'math').glob('*.html'):
            source=path.read_text(encoding='utf-8-sig');data=builder.block(source,'recorded-lecture-data')
            if not data:continue
            found+=1;ids=set()
            self.assertNotRegex(source,r'<(?:script|img|link|audio|video|source|iframe)\b[^>]*(?:src|href)\s*=\s*["\']https?://')
            self.assertNotRegex(source,r'url\s*\(\s*["\']?https?://')
            for unit in data['units']:
                self.assertNotIn(unit['id'],ids);ids.add(unit['id'])
                self.assertLessEqual(unit['start'],unit['speechEnd']);self.assertLessEqual(unit['speechEnd'],unit['end']);self.assertGreater(unit['end'],unit['start'])
                diagram=BeautifulSoup(unit['svg'],'html.parser');self.assertTrue(unit['focusIds'],unit['id'])
                for target in unit['focusIds']:self.assertIsNotNone(diagram.find(id=target),target)
            for question in data['questions']:
                units=[data['units'][i] for i in question['units']];self.assertEqual(units[0]['start'],0)
                for a,b in zip(units,units[1:]):self.assertAlmostEqual(a['end'],b['start'],places=5)
                self.assertAlmostEqual(units[-1]['end'],question['audio']['duration'],delta=.025)
                encoded=re.search(r'<script id="recorded-lecture-audio-source--'+re.escape(question['id'])+'"[^>]*>data:audio/mpeg;base64,(.*?)</script>',source,re.S)[1]
                self.assertEqual(hashlib.sha256(base64.b64decode(encoded)).hexdigest(),question['audio']['sha256'])
            self.assertNotRegex(source,r'sk-proj-[A-Za-z0-9_-]{20}')
        if not found:self.skipTest('The generated standalone lessons have not been installed yet.')
        self.assertEqual(found,12)

if __name__=='__main__':unittest.main()
