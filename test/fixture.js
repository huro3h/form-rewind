// テスト用の小さなサーバ。/form(iframe 付き)と、同じ name の欄を別の並びで持つ /form2 を返す。
const http = require('http');

const PORT = 8766;

const form = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>form</title></head>
<body>
  <form name="contact">
    <label for="name">お名前</label><input id="name" name="name">
    <label for="email">メール</label><input id="email" name="email" type="email">
    <label for="body">本文</label><textarea id="body" name="body"></textarea>
    <label><input id="agree" name="agree" type="checkbox"> 同意する</label>
    <label><input id="plan-a" type="radio" name="plan" value="a"> A</label>
    <label><input id="plan-b" type="radio" name="plan" value="b"> B</label>
    <select id="pref" name="pref"><option value="">--</option><option value="tokyo">東京</option><option value="osaka">大阪</option></select>
    <label for="pw">パスワード</label><input id="pw" name="pw" type="password">
    <input id="q" name="q" placeholder="サイト内検索">
  </form>
  <iframe id="frame" src="/frame" width="300" height="120"></iframe>
</body></html>`;

const frame = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>frame</title></head>
<body><textarea id="note" name="note"></textarea></body></html>`;

// name だけ同じで並びも構造も違うページ。email 欄は 1 秒遅れて描かれる(オートロードの後追いを試す)。
const form2 = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>form2</title></head>
<body>
  <form name="contact">
    <div><div><textarea id="body2" name="body"></textarea></div></div>
    <input id="name2" name="name" value="既定の名前">
    <select id="pref2" name="pref"><option value="">--</option><option value="tokyo">東京</option><option value="osaka">大阪</option></select>
    <div id="late"></div>
  </form>
  <script>
    setTimeout(() => {
      document.getElementById('late').innerHTML = '<input id="email2" name="email" type="email">';
    }, 1000);
  </script>
</body></html>`;

const pages = { '/form': form, '/frame': frame, '/form2': form2 };

const server = http.createServer((req, res) => {
  const body = pages[new URL(req.url, 'http://x').pathname];
  res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body || 'not found');
});

module.exports = { server, PORT };
