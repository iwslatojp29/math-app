# 月間号から教材を作成する

算数一覧の **更新** から、Google Driveに保存した月間号PDFを選びます。処理はクラウドで続くので画面やPCを閉じても構いません。完成後は算数のコンテンツ一覧とDriveの所定フォルダにHTMLが保存されます。初回またはログインの期限切れ時だけ、所有者のGoogleアカウントで接続してください。

通常は「最新モデル（自動）」を使用します。OpenAIの公式カタログの推薦と、設定されたAPIキーの利用可能モデル、画像入力・Responses対応を照合します。最新を確認できない場合は古いモデルへ黙って切り替えず、確認できた候補から明示的に選べます。モデル情報は正常時1時間、失敗時30秒で再確認し、各ジョブが使った実モデルを記録します。

## 構成

- GitHub Pages: 算数一覧の更新リンクと完成教材。
- Cloudflare Worker `/studio`: iPhone対応のPDF選択、モデル選択、進捗、完成リンク。
- SQLite Durable Object `STUDIO`: 暗号化したGoogle更新トークン、ジョブ、再開用データ、実行者の排他制御。5分間隔のアラームで画面を閉じていても中断を検出します。
- GitHub Actions `monthly-pdf.yml`: PDF解析、元ページ複製、全ページ画素比較、全問生成と独立検証、固定HTML renderer、ブラウザ検証、Drive保存、Worker経由の公開。300分経過で安全に引き継ぎます。

一時的な通信障害は保存済みの段階から最大3回再試行します。実行時間の引き継ぎはこの回数に含めません。元PDFの変更、不明な問題条件、数学や図の検証失敗、既存ファイルとの衝突は公開を保留し、画面に理由を表示します。

## 初回のサーバー設定

Workerの秘密値として `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`OPENAI_API_KEY`、`STUDIO_SECRET`、`STUDIO_RUNNER_TOKEN` を登録します。既存の `GITHUB_TOKEN` と `UPLOAD_SECRET` も保持します。Actions Secretsには `OPENAI_API_KEY` と同じ `STUDIO_RUNNER_TOKEN` を登録します。値をファイル・コミット・READMEへ記載しません。

Google CloudでDrive APIを有効にし、ウェブ用OAuthクライアントの戻り先を次の1件に限定します。

```text
https://math-app-proxy.iwslatojp29.workers.dev/api/studio/google/callback
```

Googleの権限は `openid email https://www.googleapis.com/auth/drive` です。アプリは `STUDIO_OWNER_EMAIL` に一致する、Googleが確認済みのメールアドレスだけを受け入れます。Driveの処理対象はコード内で指定した元フォルダと保存先に限定し、保存先フォルダを元PDFとして再読込しません。Google Workspace内の内部アプリを使用します。

`STUDIO_SECRET` はGoogle更新トークンとセッションの暗号化に使用します。無計画に変更すると既存接続は読めなくなります。変更が必要なときは既存処理を完了し、変更後にGoogle接続をやり直してください。セッションCookieはHttpOnly・Secure・SameSite=Lax、有効期間90日です。

## 公開と権限

公開用GitHub資格情報は対象リポジトリのContents読み書きとActions読み書きが必要です。fine-grained PATへ交換する場合もこの2権限に限定し、Workerの `GITHUB_TOKEN` を差し替えます。Actions内蔵トークンによるコミットはPages更新が起動しないため、Worker側の資格情報でHTMLと一覧を1コミットにまとめて反映します。履歴書換えやforce pushは行いません。

生成済みと確認できる同一ソースの成果物のみ更新できます。同名の手動作成ファイルや、後から人が編集した成果物は上書きしません。通常の手動アップロード上限は10MiB、クラウド生成HTMLは24MiBです。容量超過時に問題を省略しません。

原冊子、切り出し途中の画像、モデルへの入力、秘密値は公開リポジトリやActions artifactsへ保存しません。最終HTMLは依頼された公開ページに掲載され、そこに含まれる問題画像・解説は公開されます。

ローカル検証は `node --test`（proxy）と `automation/README.md` の手順を使用してください。実際のiPhone音声・iPad実機検証と、Chromiumの寸法・音声イベント模擬テストは区別します。
