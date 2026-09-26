# 月間号PDFのクラウド処理

## SAPIX の追加取り込み

SAPIX の「更新」から `/studio/sapix-import` を開き、候補を選んで確認してから取り込みます。既存の教材スタジオの管理者用 Drive 接続を使用します。採点用の Gmail 接続とは別です。API キーは Worker の `ANTHROPIC_API_KEY` シークレットに置き、ブラウザへ返しません。

対象は固定 Drive フォルダ `1f1AhUw8Yciyye8V1_eZbvTBGlpQU0EyO` とその子フォルダにある PDF・PNG・JPEG・WebP です。初回の日時判定は **2026年9月24日 0:00 JST 以降のファイル作成日時**を使います。古いファイルを移動した日時は判定できません。取り込み台帳の Drive ID で再取り込みを防ぎます。

一度に10ファイルまで選択できます。最新の利用可能な Claude Fable を Models API で調べ、確認時のモデルと資料の版をジョブへ固定します。`sapix-import.yml` が小問ごとに抽出・検算し、固定テンプレートに渡す JSON と画像を単一コミットで追加します。秘密値・中間結果・元 PDF を Actions artifact に残しません。原画像は公開される教材の出典画像として保存します。

資料が変わった場合や読み取り・答えに未解決事項がある場合は、選択したバッチ全体を公開せず履歴に理由を表示します。既存の問題・採点を置き換えません。生成済みのチェックポイントを再利用し、Pages への反映確認後に完了を表示します。1ファイル100MiB・100ページ、バッチ全体で出典画像100枚・64MiBまでです。

既存問題は `sapix/problem-parts.js` で小問ごとに表示します。元の問題の ID と記録は保持し、小問には安定した別 ID を付けます。分割前の一括採点は「情報・履歴」に表示し、小問の成績には流用しません。

```sh
python -m unittest discover -s automation/tests -p test_sapix_import.py
node --test tests/sapix-generated-problems.test.cjs tests/sapix-problem-parts.test.cjs
node --test proxy/test/sapix-import.test.mjs
```

## 月間号の処理手順

`monthly-pdf.yml` は `workflow_dispatch` の `job_id` だけを受け取り、Workerから選択済みのジョブを取得します。ブラウザを閉じても処理はGitHub Actionsで継続します。

```text
Studio job → 元PDF取得 → 全ページ画像確認・独立再検証
           → 2種類のPDFを元ページから複製 → 全ページ画素照合 → Drive保存確認
           → 両方のPDFを保存後、全問一覧 → 離れた公式解答との照合
           → 問題単位の講義生成 → 独立した数学・読みの検証
           → 固定renderer → ブラウザQA・画面画像確認 → Drive HTML保存
           → WorkerによるPagesコミット → 公開内容のSHA-256確認
```

Python 3.12、Node.js 24、`requirements.txt`、PlaywrightとChromiumを使用します。入力資料と仕様書の指示を区別し、PDF本文を実行命令として扱いません。生成モデルは `job.model` をそのまま使用し、モデルを自動で置き換えません。

実行環境には `STUDIO_URL`、`STUDIO_RUNNER_TOKEN`、`OPENAI_API_KEY`、GitHubの `GITHUB_RUN_ID` が必要です。秘密値はActions Secretsから環境変数として渡します。`GITHUB_TOKEN` はworkflow組込みトークンですが、教材の公開はWorkerに保存されたGitHub資格情報で行い、Pagesの通常の更新を起動します。秘密値や元PDFをリポジトリに追加しないでください。

```sh
python automation/run_monthly.py --job-id "$JOB_ID"
```

再開時は同じジョブを使います。ResponsesのリクエストID・検証結果とDriveの予約ファイルIDをprivate checkpointへ保存するため、完了済み生成の再課金やタイムアウト後の重複保存を避けます。checkpointにはトークン、アップロードセッションURL、元PDF、画像のbase64を保存しません。途中のPDF、画像、教材JSON、ブラウザ画面は一時ディレクトリのみで扱い、Actions artifactにアップロードしません。

最初の進捗更新で `GITHUB_RUN_ID` を担当実行として登録し、以後は `X-Studio-Run-Id` を付けます。停止済み・別実行が担当するジョブへの409応答では状態を書き換えず終了します。生成中のResponsesは同じIDを取得し直し、終端の失敗・未完了状態になったResponsesだけは再開時に新しく生成します。

一時的な通信障害はWorkerの自動再開対象として報告します。1回の実行が300分に達した場合も、ResponsesのIDと保存状況を残して次のクラウド実行へ引き継ぎます。数学・範囲・保存先の検証で保留したものは自動再試行せず、確認が必要な状態を表示します。

処理中の冊子が更新された場合、対象範囲・重要な問題条件・数学の検証に未解決事項がある場合、既存ファイルの編集者や内容を特定できない場合は、該当成果物の公開を保留します。正しい既存PDFは全ページ画像で照合して再利用できます。管理済み成果物を更新する場合は、元のDriveファイルIDを維持し、手動編集された内容を上書きしません。

HTMLは1切り出しPDFにつき1本、24MiB以内です。容量超過時に問題を省略したり、勝手に分割したりしません。ブラウザの寸法検証・模擬音声イベントと、実機試験・実音声の試聴は区別して結果に記録します。

オフライン検証:

```sh
python -m unittest discover -s automation/tests -v
node --test automation/renderer/renderer.test.mjs
```

Pythonの統合テストは公開用の幾何問題fixtureを使い、PDFの実抽出、全ページ画素照合、全問データ生成、実際のNode.js renderer CLI、自己完結HTMLの出力まで通します。外部API・Drive保存・公開・ブラウザQAはこのテストでは模擬応答です。ブラウザの実検証は `renderer/verify-lesson.mjs` が行います。

API実装の参照: [Responses background mode](https://developers.openai.com/api/docs/guides/background)、[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)、[Google Drive resumable uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads)。PDFの範囲・命名・品質基準は同梱された `specs/extract-pdf.md` と `specs/animation-html.md` を実行ごとに読み込みます。
