// IndexedDB の読み書き。service worker からだけ使う。
//   snapshots: 自動保存の履歴(固定した履歴もここ。pinned で区別)
//   fieldSets: 「すべてのフィールドを保存」の中身。オリジンごとに1件

const DB_NAME = "form-rewind";
const DB_VERSION = 1;
const SNAPSHOTS = "snapshots";
const FIELD_SETS = "fieldSets";

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const snapshots = db.createObjectStore(SNAPSHOTS, { keyPath: "id" });
      snapshots.createIndex("pageKey", "pageKey");
      snapshots.createIndex("topKey", "topKey");
      snapshots.createIndex("domain", "domain");
      db.createObjectStore(FIELD_SETS, { keyPath: "origin" });
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

const newestFirst = (a, b) => b.timestamp - a.timestamp;

export function getSnapshot(id) {
  return run(SNAPSHOTS, "readonly", (s) => done(s.get(id)));
}

export function putSnapshot(record) {
  return run(SNAPSHOTS, "readwrite", (s) => done(s.put(record)));
}

export function deleteSnapshots(ids) {
  return run(SNAPSHOTS, "readwrite", (s) => ids.forEach((id) => s.delete(id)));
}

export async function snapshotsBy(index, value) {
  const list = await run(SNAPSHOTS, "readonly", (s) => done(s.index(index).getAll(value)));
  return list.sort(newestFirst);
}

export async function countBy(index, value) {
  return run(SNAPSHOTS, "readonly", (s) => done(s.index(index).count(value)));
}

export async function allSnapshots() {
  const list = await run(SNAPSHOTS, "readonly", (s) => done(s.getAll()));
  return list.sort(newestFirst);
}

export function clearSnapshots() {
  return run(SNAPSHOTS, "readwrite", (s) => done(s.clear()));
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
