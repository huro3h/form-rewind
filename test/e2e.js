// 自動保存・復元バナー・元に戻す・差分・固定・すべてのフィールドを保存/オートロード・一時停止の E2E。
// 本物のツールバーのポップアップは Playwright から開けないので、popup.html を普通のタブで開き、
// chrome.tabs.query だけ差し替えて「フォームのタブで開いた」ことにする。
const { chromium } = require('playwright');
const os = require('os'), path = require('path'), fs = require('fs');
const { server, PORT } = require('./fixture.js');

const BRAVE = '/Applications/Brave Browser Nightly.app/Contents/MacOS/Brave Browser Nightly';
const EXT = path.resolve(__dirname, '..');
const BASE = `http://localhost:${PORT}`;
const SAVE_WAIT_MS = 2000; // 自動保存の待ち(1 秒)+余裕

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, detail) => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

(async () => {
  server.listen(PORT);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'form-rewind-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: BRAVE,
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;

  // service worker から拡張機能の IndexedDB を直接読む。まだ無ければ作らずに空を返す
  // (ここで空の DB を作ると、拡張機能側の onupgradeneeded が走らなくなる)。
  const dbAll = (store) =>
    sw.evaluate(
      (store) =>
        new Promise((resolve, reject) => {
          const req = indexedDB.open('form-rewind', 1);
          req.onupgradeneeded = () => req.transaction.abort();
          req.onerror = () => resolve([]);
          req.onsuccess = () => {
            const q = req.result.transaction(store).objectStore(store).getAll();
            q.onsuccess = () => {
              req.result.close();
              resolve(q.result);
            };
            q.onerror = () => reject(q.error);
          };
        }),
      store
    );
  const snapshotsOf = async (pathname) =>
    (await dbAll('snapshots')).filter((r) => r.pageKey === BASE + pathname);
  const badgeOf = (tabId) =>
    sw.evaluate(async (tabId) => ({
      text: await chrome.action.getBadgeText({ tabId }),
      color: (await chrome.action.getBadgeBackgroundColor({ tabId })).join(','),
    }), tabId);
  const tabIdOf = (pathname) =>
    sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, BASE + pathname);

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const frameOf = (p) => p.frames().find((f) => f.url().endsWith('/frame'));
  const ui = (p) => p.locator('#form-rewind-ui');

  // ---- 自動保存(既定はオフ) ----
  await page.goto(`${BASE}/form`);
  await sleep(500);
  await page.fill('#name', '既定では保存しない入力');
  await sleep(SAVE_WAIT_MS);
  check('既定では自動保存しない', (await snapshotsOf('/form')).length === 0);
  check('自動保存しないときは通知も出ない', (await ui(page).locator('.toast').count()) === 0);
  await sw.evaluate(() =>
    chrome.storage.local.set({ settings: { ...globalThis.FORM_REWIND_DEFAULTS, autosave: true } })
  );
  await page.reload();
  await sleep(500);
  await page.fill('#name', '山田太郎');
  await page.fill('#email', 'taro@example.com');
  await page.fill('#body', 'お問い合わせの本文です。消えると困る長い文章。');
  await page.check('#agree');
  await page.check('#plan-b');
  await page.selectOption('#pref', 'osaka');
  await page.fill('#pw', 'secret-pass');
  await page.fill('#q', '検索語');
  await frameOf(page).fill('#note', '埋め込みメモ');
  await sleep(SAVE_WAIT_MS);

  const [top] = await snapshotsOf('/form');
  const [inFrame] = await snapshotsOf('/frame');
  const names = top ? top.fields.map((f) => f.name) : [];
  check('入力すると自動で保存される', !!top && names.includes('name') && names.includes('body'));
  check('パスワード欄は保存しない', !!top && !names.includes('pw'), names.join(','));
  check('検索欄は保存しない', !!top && !names.includes('q'));
  check('iframe の入力は最上位のページに紐づけて保存', !!inFrame && inFrame.topKey === `${BASE}/form`);
  check('最初の保存で通知が出る', (await ui(page).locator('.toast').textContent().catch(() => '')).includes('自動で保存'));

  // ---- 再読み込み → バナー → 復元 → 元に戻す ----
  await page.reload();
  const banner = ui(page).locator('.banner');
  await banner.waitFor({ timeout: 5000 }).catch(() => {});
  check('再読み込みすると復元バナーが出る', await banner.isVisible());
  await banner.getByText('復元する').click();
  await sleep(800);
  const restored = await page.evaluate(() => ({
    name: document.getElementById('name').value,
    email: document.getElementById('email').value,
    body: document.getElementById('body').value,
    agree: document.getElementById('agree').checked,
    planB: document.getElementById('plan-b').checked,
    pref: document.getElementById('pref').value,
    pw: document.getElementById('pw').value,
  }));
  check(
    'バナーから全項目を復元できる',
    restored.name === '山田太郎' && restored.email === 'taro@example.com' && restored.body.startsWith('お問い合わせ') &&
      restored.agree && restored.planB && restored.pref === 'osaka',
    JSON.stringify(restored)
  );
  check('パスワード欄は復元されない', restored.pw === '');
  check('iframe の入力も復元される', (await frameOf(page).inputValue('#note')) === '埋め込みメモ');

  await ui(page).locator('.toast').getByText('元に戻す').click();
  await sleep(300);
  const undone = await page.evaluate(() => ({
    name: document.getElementById('name').value,
    planA: document.getElementById('plan-a').checked,
    planB: document.getElementById('plan-b').checked,
    agree: document.getElementById('agree').checked,
  }));
  check('「元に戻す」で復元前に戻る', undone.name === '' && !undone.planB && !undone.planA && !undone.agree, JSON.stringify(undone));

  // ---- 内容が減ったら、前の履歴を上書きせず別の履歴にする ----
  await page.fill('#name', '山田太郎');
  await page.fill('#body', 'とても大事な長い本文をここに書いています。');
  await sleep(SAVE_WAIT_MS);
  const before = (await snapshotsOf('/form')).length;
  await page.fill('#body', '');
  await sleep(SAVE_WAIT_MS);
  const after = await snapshotsOf('/form');
  check(
    '本文を消した直後の保存で、消す前の履歴が残る',
    after.length === before + 1 && after.some((r) => r.fields.some((f) => f.value === 'とても大事な長い本文をここに書いています。')),
    `${before} -> ${after.length}`
  );
  await page.fill('#body', 'あ');
  await sleep(SAVE_WAIT_MS);
  check('少しずつ書き足すだけなら履歴は増えない', (await snapshotsOf('/form')).length === after.length);

  // ---- ポップアップ ----
  const formTabId = await tabIdOf('/form');
  const popup = await context.newPage();
  popup.on('pageerror', (e) => pageErrors.push(`popup: ${e.message}`));
  await popup.addInitScript((id) => {
    const real = chrome.tabs;
    Object.defineProperty(chrome, 'tabs', {
      configurable: true,
      value: { query: async () => [{ id }], sendMessage: (...a) => real.sendMessage(...a) },
    });
    window.close = () => (window.__closed = true);
  }, formTabId);
  const openPopup = async () => {
    await popup.goto(`chrome-extension://${extId}/src/popup.html`);
    await popup.locator('#main').waitFor();
  };
  await openPopup();
  const items = popup.locator('#history .item');
  check('ポップアップにこのページの履歴が並ぶ', (await items.count()) >= 3, `${await items.count()}件`);

  // 差分: 名前だけ変えてメールを消し、名前の行だけを戻す
  await page.fill('#name', '別の名前');
  await page.fill('#email', '');
  await sleep(SAVE_WAIT_MS);
  await openPopup();
  const target = popup.locator('#history .item').filter({ hasText: 'とても大事な' }).first();
  await target.getByRole('button', { name: '差分' }).click();
  await popup.locator('#diff').waitFor();
  const changedRows = await popup.locator('.diff-row.changed').count();
  check('差分で違う項目が強調される', changedRows >= 2, `${changedRows}行`);
  await popup.locator('.diff-row').filter({ hasText: 'お名前' }).locator('input').check();
  await popup.locator('#diff-restore').click();
  await sleep(800);
  const partial = await page.evaluate(() => ({
    name: document.getElementById('name').value,
    email: document.getElementById('email').value,
  }));
  check('差分で選んだ項目だけが戻る', partial.name === '山田太郎' && partial.email === '', JSON.stringify(partial));

  // 固定
  await openPopup();
  const first = popup.locator('#history .item').first();
  await first.getByRole('button', { name: '固定', exact: true }).click();
  await first.locator('input[name=name]').fill('テンプレA');
  await first.locator('select[name=scope]').selectOption('site');
  await first.getByRole('button', { name: '固定する' }).click();
  await sleep(500);
  const pinnedText = await popup.locator('#pinned').textContent();
  const pinnedRecords = (await dbAll('snapshots')).filter((r) => r.pinned);
  check('名前を付けて固定できる', pinnedText.includes('テンプレA') && pinnedRecords.length === 1 && pinnedRecords[0].pinScope === 'site');

  // ---- すべてのフィールドを保存 / オートロード ----
  await page.fill('#name', '山田太郎');
  await page.fill('#email', 'taro@example.com');
  await page.fill('#body', '保存した本文');
  await page.selectOption('#pref', 'tokyo');
  await openPopup();
  await popup.locator('#fs-save').click();
  await sleep(800);
  const [set] = await dbAll('fieldSets');
  const keys = set ? Object.keys(set.entries) : [];
  check(
    '「すべてのフィールドを保存」でサイトに1組保存される',
    !!set && set.origin === BASE && keys.some((k) => k.endsWith('@name')) && !keys.some((k) => k.includes('@pw')),
    keys.join(' | ')
  );
  check('保存の通知が出る', (await ui(page).locator('.toast').textContent().catch(() => '')).includes('項目を保存しました'));

  const page2 = await context.newPage();
  page2.on('pageerror', (e) => pageErrors.push(`form2: ${e.message}`));
  await page2.goto(`${BASE}/form2`);
  await sleep(2500);
  const auto = await page2.evaluate(() => ({
    body: document.getElementById('body2').value,
    name: document.getElementById('name2').value,
    pref: document.getElementById('pref2').value,
    email: document.getElementById('email2')?.value,
  }));
  check('オートロード: 同じサイトの別ページでも name が同じ欄に入る', auto.body === '保存した本文' && auto.pref === 'tokyo', JSON.stringify(auto));
  check('オートロード: 入力済みの欄は上書きしない', auto.name === '既定の名前');
  check('オートロード: 後から描かれた欄にも入る', auto.email === 'taro@example.com');
  check('オートロードでは履歴を作らない', (await snapshotsOf('/form2')).length === 0);
  const form2TabId = await tabIdOf('/form2');
  const autoBadge = await badgeOf(form2TabId);
  check('バッジに読み込んだ項目数が青で出る', autoBadge.text === '3' && autoBadge.color === '26,115,232,255', JSON.stringify(autoBadge));
  check('履歴のあるページのバッジは ● のまま', (await badgeOf(formTabId)).text === '●');

  // 手動の読み込み(Shift = 空欄だけ)
  await page2.fill('#body2', '');
  await popup.addInitScript((id) => {
    const real = chrome.tabs;
    Object.defineProperty(chrome, 'tabs', {
      configurable: true,
      value: { query: async () => [{ id }], sendMessage: (...a) => real.sendMessage(...a) },
    });
  }, form2TabId);
  await openPopup();
  await popup.locator('#fs-load').click({ modifiers: ['Shift'] });
  await sleep(600);
  const shiftLoad = await page2.evaluate(() => ({
    body: document.getElementById('body2').value,
    name: document.getElementById('name2').value,
  }));
  check('Shift+読み込みは空欄だけに入れる', shiftLoad.body === '保存した本文' && shiftLoad.name === '既定の名前', JSON.stringify(shiftLoad));
  await openPopup();
  await popup.locator('#fs-load').click();
  await sleep(600);
  check('読み込みは入力済みの欄も上書きする', (await page2.inputValue('#name2')) === '山田太郎');
  check('同じ欄は数え直さず、新しく入れた欄だけ件数が増える', (await badgeOf(form2TabId)).text === '4', (await badgeOf(form2TabId)).text);
  await page2.reload();
  await sleep(2500);
  check('再読み込みすると件数は数え直す', (await badgeOf(form2TabId)).text === '3', (await badgeOf(form2TabId)).text);

  // ---- 保存したフィールドの編集画面 ----
  const editor = await context.newPage();
  editor.on('pageerror', (e) => pageErrors.push(`editor: ${e.message}`));
  const editorUrl = `chrome-extension://${extId}/src/saved-fields.html?origin=${encodeURIComponent(BASE)}`;
  await editor.goto(editorUrl);
  await editor.locator('#rows tr').first().waitFor();
  const rowOf = (label) => editor.locator('#rows tr').filter({ has: editor.locator('.field-label', { hasText: label }) });
  check(
    '編集画面に保存した項目と値が並ぶ',
    (await rowOf('お名前').locator('.value-input').inputValue()) === '山田太郎' &&
      (await editor.locator('#rows').textContent()).includes('メール') &&
      !(await editor.locator('#rows').textContent()).includes('パスワード')
  );
  await rowOf('お名前').locator('.value-input').fill('編集した名前');
  await rowOf('本文').locator('td.col-auto input').uncheck();
  check('編集すると保存バーが出る', await editor.locator('#savebar').isVisible());
  await editor.locator('#save').click();
  await sleep(500);
  const [edited] = await dbAll('fieldSets');
  const entryOf = (suffix) => Object.entries(edited.entries).find(([k]) => k.endsWith(suffix))?.[1];
  check(
    '編集画面で値と「自動」を保存できる',
    entryOf('@name')?.value === '編集した名前' && entryOf('@body')?.auto === false && !(await editor.locator('#savebar').isVisible())
  );

  await page2.reload();
  await sleep(2500);
  const afterEdit = await page2.evaluate(() => ({
    body: document.getElementById('body2').value,
    pref: document.getElementById('pref2').value,
  }));
  check('「自動」を外した欄はオートロードで入れない', afterEdit.body === '' && afterEdit.pref === 'tokyo', JSON.stringify(afterEdit));
  await openPopup();
  await popup.locator('#fs-load').click();
  await sleep(600);
  check(
    '「自動」を外した欄も手動の読み込みでは入る',
    (await page2.inputValue('#body2')) === '保存した本文' && (await page2.inputValue('#name2')) === '編集した名前'
  );

  // 編集画面を開いたまま、ページ側で保存し直す → 編集画面からの保存は止まる
  await editor.goto(editorUrl);
  await editor.locator('#rows tr').first().waitFor();
  await page2.bringToFront();
  await page2.fill('#body2', 'ページで書き直した本文');
  await openPopup();
  await popup.locator('#fs-save').click();
  await sleep(800);
  await rowOf('お名前').locator('.value-input').fill('競合する編集');
  await editor.locator('#save').click();
  await sleep(500);
  const [afterConflict] = await dbAll('fieldSets');
  const conflictEntry = (suffix) => Object.entries(afterConflict.entries).find(([k]) => k.endsWith(suffix))?.[1];
  check(
    'ページ側で更新されていたら編集画面から上書きしない',
    conflictEntry('@body')?.value === 'ページで書き直した本文' &&
      conflictEntry('@name')?.value !== '競合する編集' &&
      (await editor.locator('#message').textContent()).includes('更新されました')
  );
  check('ページで保存し直しても「自動」を外したままにする', conflictEntry('@body')?.auto === false);
  await editor.locator('#revert').click();
  await sleep(300);
  // form2 の本文欄にはラベルが無いので、保存し直した後の項目名は name の「body」になる。
  const bodyRow = editor.locator('#rows tr').filter({ has: editor.locator('.field-key', { hasText: 'name: body' }) });
  check('「元に戻す」で最新を読み直す', (await bodyRow.locator('.value-input').inputValue()) === 'ページで書き直した本文');

  // エクスポート → このサイトの分を消去 → インポートで元に戻る
  const beforeExport = (await dbAll('fieldSets'))[0].entries;
  const [download] = await Promise.all([editor.waitForEvent('download'), editor.locator('#export').click()]);
  const exportPath = await download.path();
  const exported = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
  check(
    'JSON でエクスポートできる',
    download.suggestedFilename().startsWith('form-rewind-fields-') &&
      exported.format === 'form-rewind-fields' &&
      exported.sites.length === 1 &&
      exported.sites[0].origin === BASE &&
      Object.values(exported.sites[0].entries).some((e) => e.auto === false)
  );
  await editor.locator('#delete-site').click();
  await editor.locator('#delete-site').click();
  await sleep(500);
  check('編集画面からサイトの分を消去できる', (await dbAll('fieldSets')).length === 0);
  await editor.locator('#import-file').setInputFiles(exportPath);
  await sleep(800);
  const [imported] = await dbAll('fieldSets');
  check(
    'JSON からインポートすると元に戻る(「自動」の設定も)',
    !!imported && JSON.stringify(imported.entries) === JSON.stringify(beforeExport) && (await editor.locator('#rows tr').count()) > 0
  );

  const brokenPath = path.join(userDataDir, 'broken.json');
  fs.writeFileSync(brokenPath, JSON.stringify({ format: 'form-rewind-fields', version: 1, sites: [{ origin: 'javascript:alert(1)', entries: {} }] }));
  await editor.locator('#import-file').setInputFiles(brokenPath);
  await sleep(500);
  check(
    '形式のおかしいファイルは読み込まない',
    (await editor.locator('#message').textContent()).includes('中身が壊れています') && (await dbAll('fieldSets')).length === 1
  );

  await editor.locator('#rows tr').first().locator('.value-input').fill('未保存の編集');
  check('未保存の編集中はエクスポート・インポートを押せない', (await editor.locator('#export').isDisabled()) && (await editor.locator('#import').isDisabled()));
  await editor.locator('#revert').click();
  await sleep(300);

  await openPopup();
  await popup.locator('#fs-clear').click();
  await popup.locator('#fs-clear').click();
  await sleep(600);
  check('2回押すと保存したフィールドを消去する', (await dbAll('fieldSets')).length === 0);

  // ---- 一時停止 ----
  await sw.evaluate(() =>
    chrome.storage.local.set({ settings: { ...globalThis.FORM_REWIND_DEFAULTS, autosave: true, pausedDomains: ['localhost'] } })
  );
  await sleep(300);
  const pausedBefore = (await snapshotsOf('/form2')).length;
  await page2.fill('#body2', '一時停止中の入力');
  await sleep(SAVE_WAIT_MS);
  check('一時停止中のサイトでは保存しない', (await snapshotsOf('/form2')).length === pausedBefore);

  // ---- 全体がオフでも、ポップアップで選んだサイトは自動保存する ----
  await sw.evaluate(() => chrome.storage.local.set({ settings: { ...globalThis.FORM_REWIND_DEFAULTS } }));
  await openPopup();
  check('全体がオフのときは「このサイトでは自動保存する」を出す', (await popup.locator('#site-autosave-label').textContent()) === 'このサイトでは自動保存する');
  await popup.locator('#site-autosave').check();
  await sleep(300);
  await page2.fill('#body2', '選んだサイトの入力');
  await sleep(SAVE_WAIT_MS);
  // 直前の保存から 60 秒以内だと上書きになるので、件数ではなく中身で見る。
  check(
    'ポップアップで選んだサイトは自動保存する',
    (await snapshotsOf('/form2')).some((r) => r.fields.some((f) => f.value === '選んだサイトの入力'))
  );

  check('ページ・ポップアップでエラーが出ない', pageErrors.length === 0, pageErrors.join(' / '));

  await context.close();
  server.close();
  console.log(fails ? `\n${fails} 件失敗` : '\nすべて成功');
  process.exit(fails ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
