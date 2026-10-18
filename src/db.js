// IndexedDB の読み書き。service worker からだけ使う。
//   fieldSets: 「すべてのフィールドを保存」の中身。オリジンごとに1件
// 版 1 にあった snapshots(自動保存の履歴)は、2.1 で自動保存をなくしたので版 2 で消す。

const DB_NAME = "form-rewind";
const DB_VERSION = 2;
const OLD_SNAPSHOTS = "snapshots";
const FIELD_SETS = "fieldSets";

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (db.objectStoreNames.contains(OLD_SNAPSHOTS)) db.deleteObjectStore(OLD_SNAPSHOTS);
      if (!db.objectStoreNames.contains(FIELD_SETS)) db.createObjectStore(FIELD_SETS, { keyPath: "origin" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function done(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// トランザクションが完了してから fn の結果を返す(書き込みが確定する前に返さない)。
async function run(storeName, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    let result;
    Promise.resolve(fn(tx.objectStore(storeName))).then((r) => (result = r), reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function getFieldSet(origin) {
  return run(FIELD_SETS, "readonly", (s) => done(s.get(origin)));
}

// 読んで混ぜて書くまでを1つのトランザクションで行う。同じオリジンの iframe とページ本体が
// 同時に保存しても、IndexedDB が readwrite を順番に流すので片方の分が消えない。
export function updateFieldSet(origin, update) {
  return run(FIELD_SETS, "readwrite", async (s) => {
    const record = update(await done(s.get(origin)));
    if (record) await done(s.put(record)); // null なら書かない(編集画面の競合時)
    return record;
  });
}

export function deleteFieldSet(origin) {
  return run(FIELD_SETS, "readwrite", (s) => done(s.delete(origin)));
}

export function allFieldSets() {
  return run(FIELD_SETS, "readonly", (s) => done(s.getAll()));
}
