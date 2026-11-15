// エクスポートを、一度選んだファイルへの上書きにする(git で管理しているフォルダに置いて差分を見るため)。
//
// 書き出し先は初回に保存ダイアログ(File System Access API の showSaveFilePicker)で選び、
// そのファイルのハンドルを IndexedDB に覚えておく(保存したフィールドとは別の DB)。ブラウザ・プロフィールごと。
// showSaveFilePicker が無いブラウザ(Brave など)では、固定の名前でダウンロードする。
// saved-fields.js から globalThis.FORM_REWIND_EXPORT_FILE として使う(settings.js と同じくモジュールにしない)。

(() => {
  const FILE_NAME = "form-rewind-fields.json";
  const DB_NAME = "form-rewind-export";
  const STORE = "handles";
  const HANDLE_KEY = "exportFile";

  const canPickFile = typeof window.showSaveFilePicker === "function";

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function withStore(mode, fn) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }

  // 覚えている書き出し先のハンドル。なければ null
  async function loadHandle() {
    try {
      return (await withStore("readonly", (store) => store.get(HANDLE_KEY))) ?? null;
    } catch (e) {
      return null;
    }
  }

  // 保存ダイアログで書き出し先を選ぶ。キャンセルなら null
  async function pickHandle(current) {
    try {
      const handle = await window.showSaveFilePicker({
        id: DB_NAME, // 前回選んだフォルダから開く
        suggestedName: current ? current.name : FILE_NAME,
        ...(current ? { startIn: current } : {}),
        types: [{ description: "JSON", accept: { "application/json": [".json"] } }]
      });
      await withStore("readwrite", (store) => store.put(handle, HANDLE_KEY));
      return handle;
    } catch (e) {
      if (e && e.name === "AbortError") return null;
      throw e;
    }
  }

  function download(text) {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = FILE_NAME;
    a.click();
    // すぐに破棄するとダウンロードが始まる前に URL が消えることがある
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // text を書き出し先に上書きする。ボタンのクリックの中で呼ぶ(ダイアログと許可の確認にクリックが要る)。
  // choose なら覚えている書き出し先を使わずに選び直す。
  // 戻り値: { name } 書き出したファイル名 / { name, downloaded: true } ダウンロードした / null キャンセル。
  // ファイルが消された・移動されたなどで書けなければ例外。
  async function write(text, { choose = false } = {}) {
    if (!canPickFile) {
      download(text);
      return { name: FILE_NAME, downloaded: true };
    }
    const current = await loadHandle();
    let handle = choose ? null : current;
    // 書き込みの許可はブラウザを再起動すると確認し直しになる。断られたら選び直してもらう
    if (handle && (await handle.queryPermission({ mode: "readwrite" })) !== "granted") {
      if ((await handle.requestPermission({ mode: "readwrite" })) !== "granted") handle = null;
    }
    if (!handle) {
      handle = await pickHandle(current);
      if (!handle) return null;
    }
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    return { name: handle.name };
  }

  globalThis.FORM_REWIND_EXPORT_FILE = { canPickFile, loadHandle, write };
})();
