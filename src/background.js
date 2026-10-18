// service worker。「すべてのフィールドを保存」の読み書き・送り主の検証・バッジ。
// 状態はすべて IndexedDB と chrome.storage.local にあり、ここはメモリに何も持たない。
import "./settings.js";
import * as DB from "./db.js";

const DEFAULTS = globalThis.FORM_REWIND_DEFAULTS;
const SETTINGS_KEY = globalThis.FORM_REWIND_SETTINGS_KEY;

const MAX_FIELDS = 1000;
const MAX_CHARS = 5 * 1000 * 1000;
// 読み込んだ項目数のバッジの色。
const LOADED_COLOR = "#1a73e8";
const LOADED_PREFIX = "loaded:"; // chrome.storage.session のキー。loaded:<tabId>:<frameId>
// 2.0 までの自動保存の設定。2.1 で自動保存をなくしたので、更新時に消す。
const OBSOLETE_SETTINGS = ["autosave", "maxPerPage", "retentionDays", "showToast", "pausedDomains", "enabledDomains"];
const EXTENSION_ORIGIN = new URL(chrome.runtime.getURL("")).origin;

// ページ(content script)から受け付けるのはこれだけ。残りは拡張機能のページ専用。
const CONTENT_MESSAGES = new Set([
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
// ページは自分のオリジンのデータにしか触れない。よそのサイトの保存内容を読み書きさせない。

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

function ownsOrigin(sender, origin) {
  return typeof origin === "string" && origin === originOf(sender);
}

function keysOfUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return { domain: u.hostname, origin: u.origin };
  } catch {
    return null;
  }
}

// ---- ポップアップ向け ----

async function pageInfo(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const keys = keysOfUrl(tab.url);
  if (!keys) return { ok: true, supported: false };
  const [settings, fieldSet] = await Promise.all([getSettings(), DB.getFieldSet(keys.origin)]);
  return {
    ok: true,
    supported: true,
    ...keys,
    autoload: settings.autoload,
    fieldSet: fieldSet ? { count: Object.keys(fieldSet.entries).length, updatedAt: fieldSet.updatedAt } : null,
  };
}

async function stats() {
  const sets = await DB.allFieldSets();
  return {
    ok: true,
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

async function refreshBadge(tabId) {
  try {
    const loaded = await loadedCountOf(tabId);
    await chrome.action.setBadgeText({ tabId, text: loaded > 0 ? String(loaded) : "" });
    if (loaded > 0) await chrome.action.setBadgeBackgroundColor({ tabId, color: LOADED_COLOR });
    await chrome.action.setTitle({
      tabId,
      title: loaded > 0 ? `Form Rewind(保存したフィールドを ${loaded}項目 読み込みました)` : "Form Rewind",
    });
  } catch {
    // 閉じたタブなど。印が付かないだけなので放っておく
  }
}

// ---- メッセージ ----

async function handle(msg, sender) {
  switch (msg.type) {
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
      await refreshBadge(sender.tab.id);
      return { ok: true };
    }

    case "GET_PAGE":
      return pageInfo(msg.tabId);

    case "GET_STATS":
      return stats();

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

// ---- 2.0 からの更新 ----
// 自動保存の履歴(IndexedDB の snapshots)は db.js の版上げで消える。ここでは DB を開いて版上げを済ませ、
// 使わなくなった設定を消す。onInstalled はブラウザの再起動で読み込み直したときなどに来ないので、
// service worker が起きるたびに見る(どちらも済んでいれば何もしない)。

async function cleanUpOldData() {
  await DB.allFieldSets();
  const stored = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
  if (!stored || !OBSOLETE_SETTINGS.some((k) => k in stored)) return;
  const next = { ...stored };
  OBSOLETE_SETTINGS.forEach((k) => delete next[k]);
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
}

cleanUpOldData().catch((err) => console.error("2.0 からの更新処理に失敗しました", String(err)));

// ---- バッジの更新 ----

// ページを読み込み直したら、読み込んだ項目数は数え直し。
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== "loading") return;
  await clearLoaded(tabId);
  refreshBadge(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  clearLoaded(tabId).catch(() => {});
});
