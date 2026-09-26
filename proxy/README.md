# math-app の追加・削除プロキシ

GitHub の書き込み認証は Cloudflare Workers のシークレットに保存します。公開ページには Worker の URL だけを置き、利用者は追加・削除画面に合言葉を入力します。ブラウザの localStorage / sessionStorage には保存しません。

```text
GitHub Pages /math-app/
  math / sapix / japanese / science-society の upload.html・delete.html
    → shared/proxy-client.js
      → HTTPS + Authorization: Bearer <入力した合言葉>
        → Cloudflare Worker math-app-proxy
          → GitHub Contents API → main の HTML と index.html
            → GitHub Pages が再公開
```

## 使い方

各科目の「ページを追加する」で合言葉を入力し、HTML を選択するかドラッグ＆ドロップします。必要な場合は「コンテンツ一覧へ戻る」リンクを挿入します。完了表示と新しい一覧カードの表示名は、HTML の title ではなくファイル名（既定では末尾の .html を除去）です。既存カードがあるファイルの再送信はカードを重複追加しません。

算数一覧の上部で「中学への算数」と「Sapix」を切り替えられます。それぞれ `math` と `sapix` に保存され、追加・削除は選択した教材の一覧だけに反映されます。合言葉と容量上限は共通です。月間号PDFから教材を作成する「更新」は、中学への算数側で利用します。

「ページを削除する」では公開済みの一覧を読み込んで対象を選びます。一覧に未掲載のファイルはファイル名を指定できます。削除成功後、その行は画面から消えます。反映に時間がかかる場合は GitHub Pages の再公開後に読み直してください。合言葉を間違えた場合は入力し直して再実行できます。

理科・社会の科目選択は維持しています。新規カードには data-subject を付けて既存のカード領域に挿入するため、科目タブでも表示できます。カードの文字列には科目の接頭辞を追加しません。既存教材、既存の表示名、リンクは変更しません。

## 設定とシークレット

| 種類 | 名前 | 内容 |
| --- | --- | --- |
| wrangler.toml | name | math-app-proxy |
| wrangler.toml | account_id | デプロイ先 Cloudflare Account ID（秘密情報ではありません） |
| vars | REPO | iwslatojp29/math-app |
| vars | BRANCH | main |
| vars | ALLOWED_ORIGIN | https://iwslatojp29.github.io（パスを含まない Origin） |
| vars | LABEL_WITH_EXT | false: 拡張子を除く / true: 拡張子を含む |
| Worker secret | GITHUB_TOKEN | Contents API 書き込み権限を持つ認証情報 |
| Worker secret | UPLOAD_SECRET | 追加・削除画面で入力する合言葉 |
| デプロイ環境のみ | CLOUDFLARE_API_TOKEN | 任意。未指定時は Wrangler のブラウザ認証を利用 |

シークレット値をソース、README、.env、.dev.vars、ログやコミットに書かないでください。wrangler secret put の非表示入力、または環境変数から標準入力を使います。ブラウザ認証の資格情報は OS の資格情報ストアに保存できます。

## API

SAPIX の採点記録を別端末と同期する認証・保存の説明は [SAPIX-RECORDS.md](SAPIX-RECORDS.md) を参照してください。

- POST /api/commit: `{folder, filename, contentBase64, commitMessage?, subject?}`。subject は science-society のみ「理科」「社会」を指定し、省略時は「理科」です。
- POST /api/delete: `{folder, filename}`。
- 許可 Origin での OPTIONS は 204。認証なし・不一致は 401、許可外 Origin は 403。その他のパスとメソッドは 404。

folder は小文字の英数字・ハイフン・アンダースコアの名前で、既存の index.html が必要です。proxy / shared / .github は使えません。filename は .html で終わり、ディレクトリ区切り・..・制御文字を含められません。index.html / upload.html / delete.html は保護対象です。日本語や空白を含む教材名を利用できます。HTML本体はUTF-8で10 MiB（10,485,760バイト）以内です。ブラウザで追加する「一覧へ戻る」リンクもこの容量に含みます。送信時はbase64に符号化するため通信量は約4/3倍になりますが、HTML本体の上限は10 MiBです。ブラウザはリンク挿入後のUTF-8バイト数を確認して超過ファイルの送信を止め、Workerも容量超過時には413を返します。

GitHub のファイルと一覧は別のコミットになります。競合時は新しい SHA を取得して再試行します。通信障害などで一部だけ完了した場合は同じ追加・削除を再実行すると一覧更新を再試行できます。UI は複数ファイルを順番に処理します。

## 初回準備・デプロイ

Node.js 22.12 以上で、この proxy ディレクトリから実行します。

```sh
npm ci
npx wrangler login --use-keyring
npx wrangler whoami
```

Windows で必要な場合は `npm install -g @napi-rs/keyring@1.3.0` を行い、`CLOUDFLARE_AUTH_USE_KEYRING=true` を設定すると平文保存へのフォールバックを防げます。

wrangler.toml の account_id を選択したアカウントに設定し、シークレットを登録します。次のコマンドではプロンプトにだけ値を入力してください。

```sh
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put UPLOAD_SECRET
npm test
npx wrangler deploy
```

初回の secret put が Worker 作成を求めた場合は作成します。出力された workers.dev URL を shared/proxy-client.js の API_BASE に設定します。以後の secret put は即時に新バージョンを公開するため、2つのシークレットは同じ管理対象 Worker に登録してください。

## GitHub トークンの差し替え

gh CLI の OAuth 認証は対象外のリポジトリにも権限を持つ場合があります。後日、GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens で、対象を math-app のみ、Repository permissions の Contents を Read and write にしたトークンへ差し替えることを推奨します。期限も設定してください。

新しい値がシェル変数 NEW に入っていれば、proxy ディレクトリで次の1コマンドで差し替えられます。値をコマンド行に直接書かないでください。

```sh
printf '%s' "$NEW" | npx wrangler secret put GITHUB_TOKEN
```

PowerShell では環境変数から `$env:NEW | npx wrangler secret put GITHUB_TOKEN`、または `npx wrangler secret put GITHUB_TOKEN` の非表示プロンプトを使用します。差し替え後、追加→削除のテストを行ってください。

## 合言葉のローテーション

十分に長いランダムな新しい合言葉を用意し、`npx wrangler secret put UPLOAD_SECRET` に非表示入力します。再登録後は古い合言葉が使えなくなります。サイトのソース変更や GitHub Pages の再デプロイは不要です。

## バックアップとロールバック

移行前の状態は `backup/pre-proxy-20260920-1634` タグに保存されています。確認用のチェックアウトは次のとおりです。

```sh
git switch -c inspect/pre-proxy backup/pre-proxy-20260920-1634
```

サイトを元に戻す必要がある場合は、リポジトリのルートディレクトリから次を実行します。現在の main からバックアップの対象ファイルを復元して通常のコミットで反映できます。force push は不要です。

```sh
git switch main
git pull --ff-only
git restore --source backup/pre-proxy-20260920-1634 --staged --worktree -- math japanese science-society
git commit -m "Restore pages from pre-proxy backup"
git push origin main
```

このタグは旧パスワードゲートと利用者による GitHub 認証入力方式も復元します。安全な追加・削除を続ける場合は、復元後も本プロキシ版の管理画面を使用してください。Worker の直前バージョンへ戻す場合は `npx wrangler rollback` を使用し、シークレットの状態も確認します。履歴書き換えは行いません。
