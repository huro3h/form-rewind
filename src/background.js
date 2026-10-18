// service worker。保存・一覧・復元の振り分け・掃除・バッジ。
// 状態はすべて IndexedDB と chrome.storage.local にあり、ここはメモリに何も持たない。
import "./settings.js";
import * as DB from "./db.js";

const DEFAULTS = globalThis.FORM_REWIND_DEFAULTS;
const SETTINGS_KEY = globalThis.FORM_REWIND_SETTINGS_KEY;

// 直前の保存から MERGE_WINDOW_MS 以内なら新しく足さずに上書きする(打鍵ごとに履歴が増えないように)。
// ただし最初の保存から MERGE_SPAN_MS を過ぎたら、または内容が減ったら別の履歴にする。
const MERGE_WINDOW_MS = 60 * 1000;
const MERGE_SPAN_MS = 10 * 60 * 1000;
const LOSS_CHARS = 10;
const MAX_FIELDS = 1000;
const MAX_CHARS = 5 * 1000 * 1000;
const PIN_NAME_MAX = 50;
const PREVIEW_MAX = 80;
const BADGE_TEXT = "●";
const BADGE_COLOR = "#1a73e8";
// 読み込んだ項目数のバッジ。青(履歴ありの ● と同じ色。数字か ● かで見分ける)。● より優先する。
const LOADED_COLOR = BADGE_COLOR;
const LOADED_PREFIX = "loaded:"; // chrome.storage.session のキー。loaded:<tabId>:<frameId>
const PRUNE_ALARM = "prune";
const DAY_MS = 24 * 60 * 60 * 1000;
const EXTENSION_ORIGIN = new URL(chrome.runtime.getURL("")).origin;

// ページ(content script)から受け付けるのはこれだけ。残りは拡張機能のページ専用。
const CONTENT_MESSAGES = new Set([
  "SAVE_SNAPSHOT",
  "GET_LATEST",
  "RESTORE_LATEST",
  "GET_FIELD_SET",
  "SAVE_FIELD_SET",
  "CLEAR_FIELD_SET",
  "FIELDS_LOADED",
]);

// ---- 設定 ----

async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULTS, ...stored[SETTINGS_KEY] };
}

// ---- 送り主の検証 ----
// ページは自分のオリジンのデータにしか触れない。よそのサイトの履歴を読み書きさせない。

function originOf(sender) {
  try {
    return sender.origin || new URL(sender.url).origin;
  } catch {
    return null;
  }
}

function isExtensionPage(sender) {
  return sender.id === chrome.runtime.id && originOf(sender) === EXTENSION_ORIGIN;
}

function ownsKey(sender, key) {
  const origin = originOf(sender);
  return !!origin && typeof key === "string" && key.startsWith(origin + "/");
}

function ownsOrigin(sender, origin) {
  return typeof origin === "string" && origin === originOf(sender);
}

function keysOfUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return { topKey: u.origin + u.pathname, domain: u.hostname, origin: u.origin };
  } catch {
    return null;
  }
}

// iframe から来た保存は、タブ(最上位)のページに紐づけて一覧に出す。
function topOf(sender, pageKey, domain) {
  if (sender.frameId > 0 && sender.tab) {
    const top = keysOfUrl(sender.tab.url);
    if (top) return top;
  }
  return { topKey: pageKey, domain };
}

// ---- 履歴 ----

function textOf(f) {
  if (f.values) return f.values.join(",");
  if (f.checked !== undefined) return f.checked ? "1" : "";
  return String(f.value ?? "");
}

function sameFields(a, b) {
  return a.length === b.length && a.every((f, i) => f.path === b[i].path && textOf(f) === textOf(b[i]));
}

// 前回より明らかに減った欄があるか。消してしまった直後の状態で、消す前の履歴を上書きしないため。
function losesContent(before, after) {
  const now = new Map(after.map((f) => [f.path, textOf(f)]));
  return before.some((f) => {
    const was = textOf(f);
    if (!was) return false;
    const is = now.get(f.path) ?? "";
    return is === "" || is.length <= was.length - LOSS_CHARS;
  });
}

function filledCount(fields) {
  return fields.filter((f) => (f.checked !== undefined ? f.checked : textOf(f).trim() !== "")).length;
}

// 一覧で見分けるための要約。文字の入った欄を並び順につなぐ(名前だけだと履歴どうしの区別がつかない)。
function previewOf(fields) {
  return fields
    .filter((f) => f.checked === undefined && f.tag !== "SELECT")
    .map((f) =>
      String(f.value ?? "")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean)
    .join(" / ")
    .slice(0, PREVIEW_MAX);
}

function isValidSnapshot(s) {
  if (!s || typeof s !== "object") return false;
  if (typeof s.pageKey !== "string" || typeof s.domain !== "string" || typeof s.url !== "string") return false;
  if (!Array.isArray(s.fields) || !s.fields.length || s.fields.length > MAX_FIELDS) return false;
  if (s.fields.some((f) => !f || typeof f.path !== "string")) return false;
  return JSON.stringify(s.fields).length <= MAX_CHARS;
}

async function saveSnapshot(s, sender) {
  if (!isValidSnapshot(s) || !ownsKey(sender, s.pageKey)) return { ok: false, error: "INVALID" };
  const settings = await getSettings();
  const top = topOf(sender, s.pageKey, s.domain);
  if (!globalThis.FORM_REWIND_AUTOSAVES(settings, top.domain)) return { ok: false, error: "PAUSED" };

  const now = Date.now();
  const keep = s.keep === true;
  const [latest] = (await DB.snapshotsBy("pageKey", s.pageKey)).filter((r) => !r.pinned);
  if (latest && sameFields(latest.fields, s.fields)) {
    if (keep && !latest.keep) await DB.putSnapshot({ ...latest, keep: true });
    return { ok: true };
  }
  const merge =
    latest &&
    !latest.keep &&
    !keep &&
    now - latest.timestamp < MERGE_WINDOW_MS &&
    now - latest.createdAt < MERGE_SPAN_MS &&
    !losesContent(latest.fields, s.fields);
  await DB.putSnapshot({
    id: merge ? latest.id : crypto.randomUUID(),
    createdAt: merge ? latest.createdAt : now,
    timestamp: now,
    pageKey: s.pageKey,
    topKey: top.topKey,
    domain: top.domain,
    url: s.url.slice(0, 2048),
    title: String(s.title || "").slice(0, 200),
    fields: s.fields,
    count: filledCount(s.fields),
    keep,
  });
  await prunePage(s.pageKey, settings.maxPerPage);
  if (sender.tab) refreshBadge(sender.tab.id, sender.tab.url);
  return { ok: true };
}

async function prunePage(pageKey, maxPerPage) {
  const extra = (await DB.snapshotsBy("pageKey", pageKey)).filter((r) => !r.pinned).slice(maxPerPage);
  if (extra.length) await DB.deleteSnapshots(extra.map((r) => r.id));
}

async function pruneAll() {
  const settings = await getSettings();
  const cutoff = Date.now() - settings.retentionDays * DAY_MS;
  const perPage = new Map();
  const ids = [];
  for (const r of await DB.allSnapshots()) {
    if (r.pinned) continue;
    const n = (perPage.get(r.pageKey) || 0) + 1;
    perPage.set(r.pageKey, n);
    if (r.timestamp < cutoff || n > settings.maxPerPage) ids.push(r.id);
  }
  if (ids.length) await DB.deleteSnapshots(ids);
}

// フレームごとの最新(固定したものは除く)。バナーと「最新を復元」が使う。
async function latestPerFrame(topKey) {
  const seen = new Set();
  return (await DB.snapshotsBy("topKey", topKey)).filter((r) => {
    if (r.pinned || seen.has(r.pageKey)) return false;
    seen.add(r.pageKey);
    return true;
  });
}

function summaryOf(r) {
  return {
    id: r.id,
    timestamp: r.timestamp,
    count: r.count,
    preview: previewOf(r.fields),
    inFrame: r.pageKey !== r.topKey,
    url: r.url,
    pinned: !!r.pinned,
    pinName: r.pinName || "",
    pinScope: r.pinScope || "",
  };
}

// ---- 復元・差分(タブへの送り先) ----
// 最上位のページの履歴は frameId 0 へ。iframe の履歴は全フレームへ投げ、pageKey が合うフレームだけが応える。
// 固定した履歴を同じサイトの別ページで使うときは、iframe 由来でも最上位へ入れる。

function targetOf(rec, currentTopKey) {
  if (rec.pageKey === rec.topKey || rec.topKey !== currentTopKey) {
    return { options: { frameId: 0 }, targetPageKey: null };
  }
  return { options: {}, targetPageKey: rec.pageKey };
}

async function restoreRecords(tabId, records, currentTopKey, onlyPaths) {
  let applied = 0;
  let missing = 0;
  for (const rec of records) {
    const { options, targetPageKey } = targetOf(rec, currentTopKey);
    try {
      const res = await chrome.tabs.sendMessage(
        tabId,
        { type: "RESTORE", fields: rec.fields, onlyPaths: onlyPaths || null, targetPageKey },
        options
      );
      applied += res?.applied || 0;
      missing += res?.missing || 0;
    } catch (err) {
      console.error("フレームへ復元できませんでした", { tabId, error: String(err) });
      missing += rec.fields.length;
    }
  }
  return { ok: true, applied, missing };
}

async function diffSnapshot(id, tabId) {
  const rec = await DB.getSnapshot(id);
  const tab = await chrome.tabs.get(tabId);
  const keys = keysOfUrl(tab.url);
  if (!rec || !keys) return { ok: false, error: "NOT_FOUND" };
  const { options, targetPageKey } = targetOf(rec, keys.topKey);
  let state;
  try {
    state = await chrome.tabs.sendMessage(tabId, { type: "GET_CURRENT", fields: rec.fields, targetPageKey }, options);
  } catch (err) {
    console.error("今の入力内容を読めませんでした", { tabId, error: String(err) });
  }
  if (!state) return { ok: false, error: "NO_FRAME" };
  const rows = rec.fields.map((f, i) => ({
    path: f.path,
    label: f.label || f.name || f.id || "(名前のない欄)",
    stored: state.stored[i],
    current: state.current[i],
    changed: state.current[i] !== null && state.stored[i] !== state.current[i],
  }));
  return { ok: true, rows, timestamp: rec.timestamp };
}

// ---- ポップアップ向け ----

async function pageInfo(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const keys = keysOfUrl(tab.url);
  if (!keys) return { ok: true, supported: false };
  const [onPage, onSite, settings, fieldSet] = await Promise.all([
    DB.snapshotsBy("topKey", keys.topKey),
    DB.snapshotsBy("domain", keys.domain),
    getSettings(),
    DB.getFieldSet(keys.origin),
  ]);
  const pinned = new Map();
  onPage.filter((r) => r.pinned).forEach((r) => pinned.set(r.id, r));
  onSite.filter((r) => r.pinned && r.pinScope === "site").forEach((r) => pinned.set(r.id, r));
  return {
    ok: true,
    supported: true,
    ...keys,
    autosave: settings.autosave,
    paused: settings.pausedDomains.includes(keys.domain),
    enabled: settings.enabledDomains.includes(keys.domain),
    autoload: settings.autoload,
    history: onPage.filter((r) => !r.pinned).map(summaryOf),
    pinned: Array.from(pinned.values()).sort((a, b) => b.timestamp - a.timestamp).map(summaryOf),
    fieldSet: fieldSet ? { count: Object.keys(fieldSet.entries).length, updatedAt: fieldSet.updatedAt } : null,
  };
}

async function pinSnapshot(id, name, scope) {
  const clean = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
  if (!clean || clean.length > PIN_NAME_MAX || (scope !== "page" && scope !== "site")) return { ok: false, error: "INVALID" };
  const rec = await DB.getSnapshot(id);
  if (!rec) return { ok: false, error: "NOT_FOUND" };
  await DB.putSnapshot({ ...rec, pinned: true, pinName: clean, pinScope: scope });
  return { ok: true };
}

async function unpinSnapshot(id) {
  const rec = await DB.getSnapshot(id);
  if (!rec) return { ok: false, error: "NOT_FOUND" };
  const { pinned, pinName, pinScope, ...rest } = rec;
  // 固定を外した履歴は、外した時点から保存期間を数え直す(外した途端に消えないように)。
  await DB.putSnapshot({ ...rest, timestamp: Date.now() });
  return { ok: true };
}

async function stats() {
  const [snapshots, sets] = await Promise.all([DB.allSnapshots(), DB.allFieldSets()]);
  const domains = new Map();
  snapshots.forEach((r) => domains.set(r.domain, (domains.get(r.domain) || 0) + 1));
  return {
    ok: true,
    total: snapshots.length,
    pinned: snapshots.filter((r) => r.pinned).length,
    domains: Array.from(domains, ([domain, count]) => ({ domain, count })).sort((a, b) => b.count - a.count),
    fieldSets: sets
      .map((s) => ({ origin: s.origin, count: Object.keys(s.entries).length, updatedAt: s.updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt),
  };
}

// ---- すべてのフィールドを保存 ----

async function saveFieldSet(origin, entries, radioGroups) {
  if (!entries || typeof entries !== "object" || JSON.stringify(entries).length > MAX_CHARS) {
    return { ok: false, error: "INVALID" };
  }
  const record = await DB.updateFieldSet(origin, (existing) => {
    const current = { ...existing?.entries };
    for (const g of Array.isArray(radioGroups) ? radioGroups : []) {
      Object.keys(current)
        .filter((k) => k.startsWith(g.prefix) && k !== g.keep)
        .forEach((k) => delete current[k]);
    }
    // 編集画面で「自動」を外した欄は、保存し直しても外したままにする。
    const merged = { ...current };
    for (const [k, entry] of Object.entries(entries)) {
      merged[k] = current[k]?.auto === false ? { ...entry, auto: false } : entry;
    }
    return { origin, entries: merged, updatedAt: Date.now() };
  });
  return { ok: true, entries: record.entries };
}

// 編集画面からの保存。開いた時点の updatedAt と違えば、その間にページ側で保存されたので止める
// (気づかずに上書きして、ページで保存した分を消さないため)。
async function putFieldSet(origin, entries, baseUpdatedAt) {
  if (!entries || typeof entries !== "object" || JSON.stringify(entries).length > MAX_CHARS) {
    return { ok: false, error: "INVALID" };
  }
  let conflict = false;
  const record = await DB.updateFieldSet(origin, (existing) => {
    if ((existing?.updatedAt ?? null) !== (baseUpdatedAt ?? null)) {
      conflict = true;
      return null;
    }
    return { origin, entries, updatedAt: Date.now() };
  });
  if (conflict) return { ok: false, error: "CONFLICT" };
  if (!Object.keys(entries).length) await DB.deleteFieldSet(origin);
  return { ok: true, updatedAt: record.updatedAt };
}

// ---- エクスポート / インポート(編集画面から) ----

const EXPORT_FORMAT = "form-rewind-fields";
const EXPORT_VERSION = 1;
const TAG_PATTERN = /^[A-Z][A-Z0-9-]*$/;
const KEY_MAX = 2000;

async function exportFieldSets() {
  const sets = await DB.allFieldSets();
  return {
    ok: true,
    data: {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      sites: sets.map(({ origin, updatedAt, entries }) => ({ origin, updatedAt, entries })),
    },
  };
}

function cleanOrigin(value) {
  try {
    const u = new URL(value);
    return (u.protocol === "http:" || u.protocol === "https:") && u.origin === value ? value : null;
  } catch {
    return null;
  }
}

// ファイルは手で書き換えられている前提で、知っている形の項目だけを拾い直す。
function cleanEntry(e) {
  if (!e || typeof e !== "object" || typeof e.tag !== "string" || !TAG_PATTERN.test(e.tag)) return null;
  const out = { tag: e.tag, type: typeof e.type === "string" ? e.type : "" };
  if (typeof e.value === "string") out.value = e.value;
  if (typeof e.checked === "boolean") out.checked = e.checked;
  if (Array.isArray(e.values)) out.values = e.values.filter((v) => typeof v === "string");
  if (typeof e.text === "string") out.text = e.text;
  if (e.rich === true) out.rich = true;
  if (typeof e.label === "string") out.label = e.label.slice(0, 80);
  if (e.auto === false) out.auto = false;
  if (out.value === undefined && out.checked === undefined && out.values === undefined) return null;
  return out;
}

function cleanImport(data) {
  if (!data || typeof data !== "object" || data.format !== EXPORT_FORMAT) return { error: "FORMAT" };
  if (data.version !== EXPORT_VERSION) return { error: "VERSION" };
  if (!Array.isArray(data.sites)) return { error: "FORMAT" };
  const sites = [];
  for (const site of data.sites) {
    const origin = cleanOrigin(site?.origin);
    if (!origin || !site.entries || typeof site.entries !== "object") return { error: "FORMAT" };
    const entries = {};
    for (const [key, entry] of Object.entries(site.entries)) {
      const clean = cleanEntry(entry);
      if (typeof key !== "string" || key.length > KEY_MAX || !clean) return { error: "FORMAT" };
      entries[key] = clean;
    }
    sites.push({ origin, entries });
  }
  return { sites };
}

// サイトごとに今の内容へ統合する。同じ項目はファイルの内容で上書き、ファイルに無い項目は残す。
async function importFieldSets(data) {
  if (JSON.stringify(data ?? null).length > MAX_CHARS * 4) return { ok: false, error: "TOO_LARGE" };
  const { sites, error } = cleanImport(data);
  if (error) return { ok: false, error };
  let entries = 0;
  for (const site of sites) {
    if (!Object.keys(site.entries).length) continue;
    await DB.updateFieldSet(site.origin, (existing) => ({
      origin: site.origin,
      entries: { ...existing?.entries, ...site.entries },
      updatedAt: Date.now(),
    }));
    entries += Object.keys(site.entries).length;
  }
  return { ok: true, sites: sites.filter((s) => Object.keys(s.entries).length).length, entries };
}

// ---- バッジ ----
// 読み込んだ項目数は、フレームごとに別のキーで chrome.storage.session に持つ
// (同時に報告してくるフレーム同士で読んで書いてを競わせないため)。タブで足して出す。

async function loadedCountOf(tabId) {
  const prefix = `${LOADED_PREFIX}${tabId}:`;
  const all = await chrome.storage.session.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith(prefix))
    .reduce((n, [, v]) => n + v, 0);
}

async function clearLoaded(tabId) {
  const prefix = `${LOADED_PREFIX}${tabId}:`;
  const keys = Object.keys(await chrome.storage.session.get(null)).filter((k) => k.startsWith(prefix));
  if (keys.length) await chrome.storage.session.remove(keys);
}

async function refreshBadge(tabId, url) {
  try {
    const loaded = await loadedCountOf(tabId);
    if (loaded > 0) {
      await chrome.action.setBadgeText({ tabId, text: String(loaded) });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: LOADED_COLOR });
      await chrome.action.setTitle({ tabId, title: `Form Rewind(保存したフィールドを ${loaded}項目 読み込みました)` });
      return;
    }
    const keys = keysOfUrl(url);
    const has = !!keys && (await DB.countBy("topKey", keys.topKey)) > 0;
    await chrome.action.setBadgeText({ tabId, text: has ? BADGE_TEXT : "" });
    if (has) await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR });
    await chrome.action.setTitle({ tabId, title: has ? "Form Rewind(このページの入力履歴があります)" : "Form Rewind" });
  } catch {
    // 閉じたタブなど。印が付かないだけなので放っておく
  }
}

// ---- メッセージ ----

async function handle(msg, sender) {
  switch (msg.type) {
    case "SAVE_SNAPSHOT":
      return saveSnapshot(msg.snapshot, sender);

    case "GET_LATEST": {
      if (sender.frameId !== 0 || !ownsKey(sender, msg.pageKey)) return { ok: false, error: "INVALID" };
      const records = await latestPerFrame(msg.pageKey);
      if (!records.length) return { ok: true, latest: null };
      const top = records.find((r) => r.pageKey === msg.pageKey);
      return {
        ok: true,
        latest: {
          timestamp: Math.max(...records.map((r) => r.timestamp)),
          count: records.reduce((n, r) => n + r.count, 0),
          topFields: top ? top.fields : null,
          hasFrames: records.some((r) => r.pageKey !== msg.pageKey),
        },
      };
    }

    case "RESTORE_LATEST": {
      if (sender.frameId !== 0 || !sender.tab || !ownsKey(sender, msg.pageKey)) return { ok: false, error: "INVALID" };
      const records = await latestPerFrame(msg.pageKey);
      if (!records.length) return { ok: false, error: "NOT_FOUND" };
      return restoreRecords(sender.tab.id, records, msg.pageKey);
    }

    case "GET_FIELD_SET": {
      if (!ownsOrigin(sender, msg.origin) && !isExtensionPage(sender)) return { ok: false, error: "INVALID" };
      const set = await DB.getFieldSet(msg.origin);
      return { ok: true, entries: set?.entries || null, updatedAt: set?.updatedAt ?? null };
    }

    case "PUT_FIELD_SET":
      return putFieldSet(msg.origin, msg.entries, msg.baseUpdatedAt);

    case "EXPORT_FIELD_SETS":
      return exportFieldSets();

    case "IMPORT_FIELD_SETS":
      return importFieldSets(msg.data);

    case "SAVE_FIELD_SET":
      if (!ownsOrigin(sender, msg.origin)) return { ok: false, error: "INVALID" };
      return saveFieldSet(msg.origin, msg.entries, msg.radioGroups);

    case "CLEAR_FIELD_SET":
      if (!ownsOrigin(sender, msg.origin) && !isExtensionPage(sender)) return { ok: false, error: "INVALID" };
      await DB.deleteFieldSet(msg.origin);
      return { ok: true };

    case "FIELDS_LOADED": {
      if (!sender.tab || !Number.isInteger(msg.count) || msg.count < 0 || msg.count > MAX_FIELDS) {
        return { ok: false, error: "INVALID" };
      }
      await chrome.storage.session.set({ [`${LOADED_PREFIX}${sender.tab.id}:${sender.frameId}`]: msg.count });
      await refreshBadge(sender.tab.id, sender.tab.url);
      return { ok: true };
    }

    case "GET_PAGE":
      return pageInfo(msg.tabId);

    case "RESTORE_SNAPSHOT": {
      const rec = await DB.getSnapshot(msg.id);
      const keys = keysOfUrl((await chrome.tabs.get(msg.tabId)).url);
      if (!rec || !keys) return { ok: false, error: "NOT_FOUND" };
      return restoreRecords(msg.tabId, [rec], keys.topKey, msg.onlyPaths);
    }

    case "DIFF_SNAPSHOT":
      return diffSnapshot(msg.id, msg.tabId);

    case "DELETE_SNAPSHOT":
      await DB.deleteSnapshots([msg.id]);
      if (Number.isInteger(msg.tabId)) refreshBadge(msg.tabId, (await chrome.tabs.get(msg.tabId)).url);
      return { ok: true };

    case "PIN_SNAPSHOT":
      return pinSnapshot(msg.id, msg.name, msg.scope);

    case "UNPIN_SNAPSHOT":
      return unpinSnapshot(msg.id);

    case "GET_STATS":
      return stats();

    case "DELETE_DOMAIN_HISTORY": {
      const ids = (await DB.snapshotsBy("domain", msg.domain)).map((r) => r.id);
      await DB.deleteSnapshots(ids);
      return { ok: true, deleted: ids.length };
    }

    case "DELETE_ALL_HISTORY":
      await DB.clearSnapshots();
      return { ok: true };

    default:
      return { ok: false, error: "UNKNOWN_MESSAGE" };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return false;
  if (!isExtensionPage(sender) && !CONTENT_MESSAGES.has(msg.type)) {
    sendResponse({ ok: false, error: "FORBIDDEN" });
    return false;
  }
  handle(msg, sender)
    .then(sendResponse)
    .catch((err) => {
      console.error("処理に失敗しました", { type: msg.type, error: String(err) });
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    });
  return true;
});

// ---- ショートカット(キーは割り当てない。chrome://extensions/shortcuts で各自設定) ----

const COMMANDS = {
  "01_save-fields": { type: "FIELD_SET_SAVE" },
  "02_load-fields": { type: "FIELD_SET_LOAD", onlyEmpty: false },
  "03_load-empty-fields": { type: "FIELD_SET_LOAD", onlyEmpty: true },
};

chrome.commands.onCommand.addListener((command, tab) => {
  const msg = COMMANDS[command];
  if (!msg || !tab || !keysOfUrl(tab.url)) return;
  chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
});

// ---- 掃除とバッジの更新 ----

function ensureAlarm() {
  chrome.alarms.get(PRUNE_ALARM, (alarm) => {
    if (!alarm) chrome.alarms.create(PRUNE_ALARM, { periodInMinutes: 60 });
  });
}

chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PRUNE_ALARM) pruneAll().catch((err) => console.error("古い履歴の削除に失敗しました", String(err)));
});

// ページを読み込み直したら、読み込んだ項目数は数え直し(● の表示に戻る)。
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status === "loading") await clearLoaded(tabId);
  if (info.status === "loading" || info.status === "complete" || info.url) refreshBadge(tabId, tab.url);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  clearLoaded(tabId).catch(() => {});
});
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    refreshBadge(tabId, (await chrome.tabs.get(tabId)).url);
  } catch {
    // タブがすでに閉じられている
  }
});
