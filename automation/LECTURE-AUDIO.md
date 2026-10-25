# 講義教材の事前生成音声

算数の講義機能を持つ12ページを対象にします。通常解説・答え・原問画像は元のHTMLに保持し、講義には録音済み音声と実測時刻表を追加します。完成HTMLは単独で開けます。

## 制作環境

Windows x64 / Python 3.12、VOICEVOX CORE 0.17.1、音声モデル0.vvm 0.17.0、四国めたん・ノーマル（スタイル2）を使用します。生成速度0.97、ピッチ−0.025、抑揚1.0、モノラル24kHzです。モデルの取得以外で、教材原稿を外部音声サービスに送りません。

- [VOICEVOX CORE公式リリース](https://github.com/VOICEVOX/voicevox_core/releases/tag/0.17.1)
- [音声モデルと利用条件](https://github.com/VOICEVOX/voicevox_vvm)
- [ONNX Runtime](https://github.com/VOICEVOX/onnxruntime-builder/releases/tag/voicevox_onnxruntime-1.17.3)
- [Open JTalk辞書](https://github.com/r9y9/open_jtalk/releases/tag/v1.11.1)

生成音声のクレジット「VOICEVOX:四国めたん」を各教材に表示します。音声モデルと音声ライブラリの利用条件も確認してください。

## 再生成

リポジトリの隣に作業用の `lecture-tts`、`lecture-data`、`lecture-built` を用意します。`lecture-tts/venv` に `lecture-audio-requirements.txt` と公式のホスト用VOICEVOX wheelをインストールします。`lecture-tts` 直下に `0.vvm`、`open_jtalk_dic_utf_8-1.11/`、`voicevox_onnxruntime-win-x64-1.17.3/lib/voicevox_onnxruntime.dll` を配置してください。

```powershell
../lecture-tts/venv/Scripts/python.exe automation/recorded_lectures.py --extract ../lecture-data
../lecture-tts/venv/Scripts/python.exe automation/synthesize_lectures.py --data ../lecture-data --tts ../lecture-tts --workers 4
../lecture-tts/venv/Scripts/python.exe automation/package_lectures.py --data ../lecture-data --tts ../lecture-tts --out ../lecture-built
```

既存の動的SVGの初期描画は `lecture-diagrams/` に保存しています。原図の描画コードを変更した場合は、jsdomをローカルに用意し、`snapshot_lecture_diagrams.cjs --jsdom <jsdomのディレクトリ>` で更新してください。外部リソースは読み込みません。

生成は原稿・モデル・声の条件から決めたハッシュで再開できます。中断しても、検証済みの区切りを再生成しません。制作に使うAPIキーは不要です。

## 音声・同期データ

読む文章 `displayText`、音声原稿 `speechText`、問題固有の読み指定 `pronunciations` を分けます。時間と分数、単位、点名、下向き矢印や括弧等の独自記号を区別します。元の読み指定も参照用に保持します。

各区切りの開始・発話終了・間を含む終了をPCMのフレーム数で記録します。MP3への符号化後に再びデコードし、長さを照合します。HTMLに入れた音声データのSHA-256を、検証したMP3と照合します。

月号全体は長いため、音源は問題ごとに分けてHTMLへ内包します。継続利用するaudio要素は一つです。通常64kbps、長大な教材は公開可能なファイル容量に収まる範囲で56kbpsまたは48kbpsを使用します。ページごとの条件は埋め込みデータと制作記録で確認できます。

大きな録音データは初期化時にメモリーへ読み取り、録音用scriptノードを表示DOMから除去します。配布するHTMLファイル内の音声はすべて保持されます。表示だけの再ビルドでは、原稿・音声ハッシュ・時刻表が一致する検証済みMP3を再利用します。

再生位置は `audio.currentTime` が基準です。図の強調と移動・回転・反転も同じ時刻から描きます。一時停止は位置を保ち、速度変更は `playbackRate` と `preservesPitch` を使います。音声OFFは同じ録音をミュートします。音声が使えない場合も前・次、図、通常解説、全講義の書き起こしで学べます。

`?lecture=<問題ID>` で、再生を開始せずにその問題の講義を直接開けます。通常解説へ戻るときは、選択した問題を引き継ぎます。AIへ質問するときは講義を一時停止し、表示中の講義の条件・説明・式を参照します。

講義画面は上部の操作バー、常設の左側の問題一覧、中央の図、右側の現在の説明で構成します。下部に操作欄を置かず、iPad横画面では各ステップを同時に読める高さを確保します。再生速度・音声・文字・図の拡大率は上部の「再生・表示設定」、条件・既知の関係・全講義の書き起こしは「条件・全文」から開きます。本文は必要に応じて16pxまで、表は14pxまでの範囲で表示領域に合わせます。複数図は利用可能な縦横比に合わせて配置し、長い表は列幅・余白を詰めて表示します。24行を超える表は先頭・末尾の概要を示し、上部の「表」で18行ずつ全行を選べます。全行をまとめて読む表示は「条件・全文」に残します。スマートフォンでは問題一覧を保ち、図と説明を縦に並べます。

## 確認

```powershell
node --test tests/recorded-lecture.test.cjs tests/math-tutor.test.cjs
../lecture-tts/venv/Scripts/python.exe -m unittest automation.tests.test_recorded_lectures -v
node automation/check_lecture_dom.cjs --jsdom <jsdomのディレクトリ> --html-dir math --report <確認記録.json>
```

再生・同期の動作確認、音声の実際の試聴、iPad実機での確認は別々に記録してください。波形・発音データの検査や、iPad相当の画面幅での表示確認を、試聴や実機確認の代わりとして報告しません。

`check_lecture_dom.cjs` は、音声を模擬したDOM・イベントの回帰確認です。書き起こしの全区切り、問題選択、印刷前後の開閉状態と停止、通常解説への復帰を確認します。実音声の再生開始は、完成HTMLをブラウザーで別に確認し、音源ハッシュと区切りIDを記録します。
