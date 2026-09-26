# PDFを切り出して、Chatで解説HTMLを作る

算数一覧の **更新** からStudioを開きます。初回またはログインの期限切れ時だけ、所有者のGoogleアカウントで接続してください。

## 使い方

1. **PDFを切り出す**：元の月間号PDFを選び、実行ボタンを押します。API経由のAIが範囲を判定・検証し、日日系と発展・学コン系のPDFをDriveへ保存します。画面やPCを閉じても、このクラウド処理は続きます。
2. **Chatに渡す**：保存済みの切り出しPDFを選び、PDFとMD指示書をダウンロードします。両方をChatに添付し、画面の依頼文を貼り付けて解答解説HTMLを作ります。ダウンロードしただけでは生成を始めません。
3. **完成HTMLを取り込む**：Chatから完成したHTMLを取得し、追加画面で合言葉を入力してファイルを選びます。ファイル形式・容量と静的プレビューを確認し、**一覧へ追加**で公開します。

MDは `automation/specs/animation-html.md` をそのまま配信します。ユーザーから渡された作成指示書と改行を除いて同一です。図・音声・全対象問題・小問・公式解答との照合などの内容条件は変更しません。Chat側でDrive保存ができない場合も、完成HTMLをダウンロードして取り込めます。

Chatへのファイル添付は利用者が行います。StudioからChatへ自動送信したり、ブラウザ内のChatを自動操作したりしません。取り込み先は既存の `math/upload.html` と公開APIです。取り込みによるHTMLのDrive保存は行いません。

静的プレビューでは外部通信とスクリプトを無効にしています。アニメーション・音声はChatのプレビューまたは保存したHTMLで確認してください。JavaScriptで内容を描画するHTMLは静的プレビューが空になる場合があります。公開するHTML本体のスクリプトは保持します。取り込みは数学的正しさを自動認定する処理ではありません。

## 利用枠と処理の分担

- PDF切り出しは、登録したOpenAI APIキーの利用料金が発生します。
- PDF・MDのダウンロード、HTMLの取り込みは生成APIを呼びません。
- Chatでの生成は、そのChatに適用されるプラン・利用枠で処理されます。
- 旧方式のAPIによるHTML生成は、新規作成・再試行・自動再開を停止します。既存の成果物と履歴は残します。

PDF切り出しでは「最新モデル（自動）」または明示した利用可能モデルを使います。Chatへの受け渡しにはモデル設定やAPIのモデル一覧取得は必要ありません。

## 構成

- GitHub Pages：算数一覧、完成HTML、取り込み画面。
- Cloudflare Worker `/studio`：PDF選択、切り出しの進捗、Chat用ダウンロード、取り込み画面への導線。
- Durable Object `STUDIO`：Google接続、ジョブ、再開記録、実行者の排他制御。
- GitHub Actions `monthly-pdf.yml`：PDF解析、元ページの複製、全ページ画素比較、Drive保存。300分で保存済み段階を次の実行へ引き継ぎます。

切り出しの一時的な通信障害は保存済みの段階から最大3回再試行します。元PDFの変更、収録範囲の未確定、既存ファイルとの衝突は保留します。ページ分類では原画像と隣接ページ・確認済みのコーナー見出し・印刷ページ対応を照合し、解答が離れたページにある場合も確認します。固定ページ番号だけで切り出しません。

Chat用PDFは、固定の出力フォルダにあるPDFだけ取得できます。一覧の更新日時・ファイル属性を再照合し、上限100MiBでストリーミングします。認証必須で共有キャッシュには保存しません。指示書とファイルを読むだけでGitHub Actionsや生成APIは起動しません。

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

現在のHTML取り込みは既存の手動アップロードを使い、上限は10MiBです。同名のHTMLを追加するとその公開ファイルを更新するため、別の教材には異なる名前を使います。旧API生成の履歴では、同一ソース・生成時の内容が確認できる成果物だけを更新する保護情報を保持しています。旧クラウド生成の上限は24MiBでした。

原冊子、切り出し途中の画像、モデルへの入力、秘密値は公開リポジトリやActions artifactsへ保存しません。最終HTMLは依頼された公開ページに掲載され、そこに含まれる問題画像・解説は公開されます。

ローカル検証は `node --test`（proxy）と `automation/README.md` の手順を使用してください。実際のiPhone音声・iPad実機検証と、Chromiumの寸法・音声イベント模擬テストは区別します。
