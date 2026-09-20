// Set API_BASE to the deployed Cloudflare Worker URL before publishing.
(function () {
  'use strict';
  const API_BASE = 'https://math-app-proxy.iwslatojp29.workers.dev';
  const MAX_HTML_BYTES = 10 * 1024 * 1024;
  const PROTECTED_FILES = new Set(['index.html', 'upload.html', 'delete.html']);

  class ProxyError extends Error {
    constructor(message, status = 0) {
      super(message);
      this.name = 'ProxyError';
      this.status = status;
    }
  }

  function validFilename(filename) {
    return typeof filename === 'string' && /\.html$/i.test(filename)
      && !/[\/\\\u0000-\u001f\u007f]/.test(filename)
      && !filename.includes('..') && !PROTECTED_FILES.has(filename.toLowerCase());
  }

  function statusMessage(status) {
    if (status === 400) return '入力内容を確認してください (400)。';
    if (status === 401) return '合言葉が正しくありません。入力し直して再実行してください (401)。';
    if (status === 403) return 'このページからの操作は許可されていません (403)。';
    if (status === 404) return '対象ファイルまたは操作先が見つかりません (404)。';
    if (status === 409) return '別の更新と競合しました。少し待って再実行してください (409)。';
    if (status === 413) return 'HTMLの容量が上限の10 MiB（戻るリンク挿入後、UTF-8）を超えています。ファイルを小さくして再実行してください (413)。';
    if (status === 429) return '操作が集中しています。少し待って再実行してください (429)。';
    return '処理を完了できませんでした (' + status + ')。一覧を確認してから再実行してください。';
  }

  async function post(path, body, passphrase) {
    if (typeof passphrase !== 'string' || passphrase.length === 0) {
      throw new ProxyError('合言葉を入力してください。');
    }
    if (API_BASE.includes('REPLACE_SUBDOMAIN')) {
      throw new ProxyError('操作先が未設定です。管理者に連絡してください。');
    }
    let response;
    try {
      response = await fetch(API_BASE + path, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + passphrase, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error'
      });
    } catch (error) {
      throw new ProxyError('通信できませんでした。反映状況を一覧で確認してから再実行してください。');
    }
    if (!response.ok) throw new ProxyError(statusMessage(response.status), response.status);
    let result;
    try {
      result = await response.json();
    } catch (error) {
      throw new ProxyError('応答を確認できませんでした。反映状況を一覧で確認してください。', response.status);
    }
    if (!result || result.ok !== true) {
      throw new ProxyError('処理結果を確認できませんでした。反映状況を一覧で確認してください。', response.status);
    }
    return result;
  }

  async function commit(body, passphrase) {
    const result = await post('/api/commit', body, passphrase);
    if (typeof result.label !== 'string') {
      throw new ProxyError('表示名を確認できませんでした。反映状況を一覧で確認してください。');
    }
    return result;
  }

  function deleteFile(body, passphrase) {
    return post('/api/delete', body, passphrase);
  }

  function errorMessage(error) {
    return error instanceof ProxyError ? error.message : '処理に失敗しました。入力内容と反映状況を確認してください。';
  }

  function assertHtmlSize(byteLength) {
    if (byteLength > MAX_HTML_BYTES) {
      const size = (byteLength / (1024 * 1024)).toFixed(2) + ' MiB（' + byteLength.toLocaleString('ja-JP') + 'バイト）';
      throw new ProxyError('HTMLの容量は戻るリンク挿入後で' + size + 'です。上限10 MiB（10,485,760バイト）以内に小さくして再実行してください。', 413);
    }
  }

  window.MathAppProxy = Object.freeze({ API_BASE, MAX_HTML_BYTES, assertHtmlSize, commit, deleteFile, validFilename, errorMessage });
})();
