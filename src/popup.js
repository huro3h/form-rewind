"use strict";

const DEFAULTS = globalThis.FORM_REWIND_DEFAULTS;
const SETTINGS_KEY = globalThis.FORM_REWIND_SETTINGS_KEY;
const CONFIRM_MS = 3000;

const $ = (id) => document.getElementById(id);

let tabId = null;
let page = null; // GET_PAGE の結果
let diffId = null;

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function showMessage(text, isError = false) {
  const el = $("message");
  el.textContent = text;
  el.classList.toggle("error", isError);
  el.hidden = false;
}

function relativeTime(ts) {
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return "たった今";
  if (min < 60) return `${min}分前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}時間前`;
  return `${Math.floor(hours / 24)}日前`;
}

function absoluteTime(ts) {
  return new Date(ts).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

async function updateSettings(patch) {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const next = { ...DEFAULTS, ...stored[SETTINGS_KEY], ...patch(stored[SETTINGS_KEY] || {}) };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
}

// ---- 一覧 ----

function renderItem(item, { pinned }) {
  const li = $("item-template").content.firstElementChild.cloneNode(true);
  li.querySelector(".item-name").textContent = pinned ? item.pinName : relativeTime(item.timestamp);
  const meta = [pinned ? absoluteTime(item.timestamp) : null, `${item.count}項目`];
  if (item.inFrame) meta.push("埋め込みフォーム");
  if (pinned && item.pinScope === "site") meta.push("サイト全体");
  li.querySelector(".item-meta").textContent = meta.filter(Boolean).join("・");
  li.querySelector(".item-meta").title = absoluteTime(item.timestamp);
  li.querySelector(".item-preview").textContent = item.preview || "(文字の入力なし)";
  li.querySelector('[data-action="pin"]').hidden = pinned;
  li.querySelector('[data-action="unpin"]').hidden = !pinned;
  li.querySelector('[data-action="delete"]').hidden = pinned;

  li.querySelector(".item-actions").addEventListener("click", (e) => {
    const action = e.target.dataset.action;
    if (action) runAction(action, item, li);
  });
  const form = li.querySelector(".pin-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const res = await send({
      type: "PIN_SNAPSHOT",
      id: item.id,
      name: form.elements.name.value,
      scope: form.elements.scope.value,
    });
    if (!res.ok) {
      showMessage("名前は1〜50文字で入力してください。", true);
      return;
    }
    showMessage("固定しました。保存期間や件数の上限で消えなくなります。");
    await refresh();
  });
  return li;
}

async function runAction(action, item, li) {
  if (action === "restore") {
    const res = await send({ type: "RESTORE_SNAPSHOT", id: item.id, tabId });
    if (res.ok) window.close();
    else showMessage("復元できませんでした。ページを再読み込みしてお試しください。", true);
  } else if (action === "diff") {
    await openDiff(item);
  } else if (action === "pin") {
    const form = li.querySelector(".pin-form");
    form.hidden = !form.hidden;
    if (!form.hidden) {
      form.elements.name.value = item.preview.slice(0, 50);
      form.elements.name.focus();
    }
  } else if (action === "unpin") {
    await send({ type: "UNPIN_SNAPSHOT", id: item.id });
    showMessage("固定を解除しました。履歴の一覧に戻ります。");
    await refresh();
  } else if (action === "delete") {
    await send({ type: "DELETE_SNAPSHOT", id: item.id, tabId });
    await refresh();
  }
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
  $("paused").checked = page.paused;
  $("autoload").checked = page.autoload;
  renderFieldSetStatus();

  const pinnedList = $("pinned");
  pinnedList.replaceChildren(...page.pinned.map((item) => renderItem(item, { pinned: true })));
  $("pinned-section").hidden = !page.pinned.length;

  const historyList = $("history");
  historyList.replaceChildren(...page.history.map((item) => renderItem(item, { pinned: false })));
  $("history-empty").hidden = page.history.length > 0;
  $("restore-latest").hidden = page.history.length === 0;
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

// ---- 差分 ----

async function openDiff(item) {
  const res = await send({ type: "DIFF_SNAPSHOT", id: item.id, tabId });
  if (!res.ok) {
    showMessage("このページの入力欄を読み取れませんでした。ページを再読み込みしてお試しください。", true);
    return;
  }
  diffId = item.id;
  $("diff-title").textContent = `${absoluteTime(res.timestamp)} の保存内容と比較`;
  // どちらも空(またはオフ)のままの欄は比べる意味がないので出さない。違う行を上に寄せる。
  const blank = (v) => v === "" || v === "オフ" || v === null;
  const rows = res.rows
    .filter((r) => r.changed || !blank(r.stored) || !blank(r.current))
    .sort((a, b) => Number(b.changed) - Number(a.changed));
  const head = document.createElement("li");
  head.className = "diff-row diff-head muted small";
  head.innerHTML = '<span></span><span class="value">保存した内容</span><span class="value">今の内容</span>';
  $("diff-list").replaceChildren(
    head,
    ...rows.map((row) => {
      const li = document.createElement("li");
      li.className = "diff-row" + (row.changed ? " changed" : "");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = row.path;
      box.disabled = row.current === null;
      box.checked = false;
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = row.label;
      const stored = document.createElement("span");
      stored.className = "value";
      stored.textContent = row.stored === "" ? "(空)" : row.stored;
      const current = document.createElement("span");
      current.className = "value current";
      current.textContent = row.current === null ? "(このページに欄がありません)" : row.current === "" ? "(空)" : row.current;
      li.append(box, label, stored, current);
      return li;
    })
  );
  if (!rows.length) {
    const li = document.createElement("li");
    li.className = "muted small";
    li.textContent = "比べられる項目がありません。";
    $("diff-list").append(li);
  }
  $("diff-all").checked = false;
  updateDiffButton();
  $("main").hidden = true;
  $("diff").hidden = false;
}

function diffBoxes() {
  return Array.from($("diff-list").querySelectorAll(".diff-row input[type=checkbox]"));
}

function updateDiffButton() {
  const n = diffBoxes().filter((b) => b.checked).length;
  $("diff-restore").disabled = n === 0;
  $("diff-restore").textContent = n ? `選んだ${n}項目を復元` : "選んだ項目を復元";
}

function closeDiff() {
  diffId = null;
  $("diff").hidden = true;
  $("main").hidden = false;
}

// ---- イベント ----

$("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

$("restore-latest").addEventListener("click", async () => {
  const [latest] = page.history;
  if (!latest) return;
  const res = await send({ type: "RESTORE_SNAPSHOT", id: latest.id, tabId });
  if (res.ok) window.close();
  else showMessage("復元できませんでした。ページを再読み込みしてお試しください。", true);
});

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

$("paused").addEventListener("change", (e) => {
  const paused = e.target.checked;
  updateSettings((s) => {
    const list = new Set(s.pausedDomains || []);
    if (paused) list.add(page.domain);
    else list.delete(page.domain);
    return { pausedDomains: Array.from(list) };
  });
});

$("diff-back").addEventListener("click", closeDiff);
$("diff-all").addEventListener("change", (e) => {
  diffBoxes().forEach((b) => {
    if (!b.disabled) b.checked = e.target.checked && b.closest(".diff-row").classList.contains("changed");
  });
  updateDiffButton();
});
$("diff-list").addEventListener("change", updateDiffButton);
$("diff-restore").addEventListener("click", async () => {
  const onlyPaths = diffBoxes()
    .filter((b) => b.checked)
    .map((b) => b.value);
  const res = await send({ type: "RESTORE_SNAPSHOT", id: diffId, tabId, onlyPaths });
  if (res.ok) window.close();
  else showMessage("復元できませんでした。ページを再読み込みしてお試しください。", true);
});

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab.id;
  await refresh();
})();
