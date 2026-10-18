"use strict";

const DEFAULTS = globalThis.FORM_REWIND_DEFAULTS;
const SETTINGS_KEY = globalThis.FORM_REWIND_SETTINGS_KEY;
const CONFIRM_MS = 3000;

const $ = (id) => document.getElementById(id);

let tabId = null;
let page = null; // GET_PAGE の結果

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function showMessage(text, isError = false) {
  const el = $("message");
  el.textContent = text;
  el.classList.toggle("error", isError);
  el.hidden = false;
}

function absoluteTime(ts) {
  return new Date(ts).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

async function updateSettings(patch) {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const next = { ...DEFAULTS, ...stored[SETTINGS_KEY], ...patch(stored[SETTINGS_KEY] || {}) };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
}

function renderFieldSetStatus() {
  const fs = page.fieldSet;
  $("fs-status").textContent = fs
    ? `このサイトに ${fs.count}項目を保存しています(${absoluteTime(fs.updatedAt)} 更新)`
    : "このサイトに保存したフィールドはありません";
  $("fs-load").disabled = !fs;
  $("fs-view").hidden = !fs;
  $("fs-clear").disabled = !fs;
}

function render() {
  $("domain").textContent = page.domain;
  $("main").hidden = false;
  $("autoload").checked = page.autoload;
  renderFieldSetStatus();
}

async function refresh() {
  page = await send({ type: "GET_PAGE", tabId });
  if (!page.ok || !page.supported) {
    $("unsupported").hidden = false;
    $("main").hidden = true;
    return;
  }
  render();
}

// ---- イベント ----

$("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

// すべてのフィールドを保存/読み込み/消去 はタブの全フレームへ直接送る(フレームごとに自分のオリジンの分を扱う)。
async function sendToTab(message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return true;
  } catch {
    showMessage("このページと通信できませんでした。ページを再読み込みしてお試しください。", true);
    return false;
  }
}

$("fs-view").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL(`src/saved-fields.html?origin=${encodeURIComponent(page.origin)}`) });
  window.close();
});

$("fs-save").addEventListener("click", async () => {
  if (await sendToTab({ type: "FIELD_SET_SAVE" })) window.close();
});

$("fs-load").addEventListener("click", async (e) => {
  if (await sendToTab({ type: "FIELD_SET_LOAD", onlyEmpty: e.shiftKey })) window.close();
});

let clearArmed = null;
$("fs-clear").addEventListener("click", async () => {
  const button = $("fs-clear");
  if (!clearArmed) {
    button.textContent = "本当に消去";
    clearArmed = setTimeout(() => {
      clearArmed = null;
      button.textContent = "消去";
    }, CONFIRM_MS);
    return;
  }
  clearTimeout(clearArmed);
  clearArmed = null;
  button.textContent = "消去";
  // フレーム側の消去に加え、ページと通信できない場合に備えて最上位のオリジンはここでも消す。
  await sendToTab({ type: "FIELD_SET_CLEAR" });
  await send({ type: "CLEAR_FIELD_SET", origin: page.origin });
  await refresh();
});

$("autoload").addEventListener("change", (e) => updateSettings(() => ({ autoload: e.target.checked })));

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab.id;
  await refresh();
})();
