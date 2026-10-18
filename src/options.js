"use strict";

const DEFAULTS = globalThis.FORM_REWIND_DEFAULTS;
const SETTINGS_KEY = globalThis.FORM_REWIND_SETTINGS_KEY;
const CONFIRM_MS = 3000;

const $ = (id) => document.getElementById(id);

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function absoluteTime(ts) {
  return new Date(ts).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULTS, ...stored[SETTINGS_KEY] };
}

async function setSettings(patch) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...(await getSettings()), ...patch } });
}

// 押し間違いを避けるため、消す操作は2回押させる。
function confirmButton(button, label, onConfirm) {
  let armed = null;
  button.textContent = label;
  button.addEventListener("click", async () => {
    if (!armed) {
      button.textContent = "もう一度押すと削除します";
      armed = setTimeout(() => {
        armed = null;
        button.textContent = label;
      }, CONFIRM_MS);
      return;
    }
    clearTimeout(armed);
    armed = null;
    button.textContent = label;
    await onConfirm();
  });
}

function row(name, detail, buttonLabel, onClick, { confirm = false, link = null } = {}) {
  const li = document.createElement("li");
  const text = document.createElement("span");
  text.className = "name";
  text.textContent = name;
  if (detail) {
    const sub = document.createElement("span");
    sub.className = "muted small";
    sub.textContent = `  ${detail}`;
    text.append(sub);
  }
  const button = document.createElement("button");
  button.type = "button";
  if (confirm) confirmButton(button, buttonLabel, onClick);
  else {
    button.textContent = buttonLabel;
    button.addEventListener("click", onClick);
  }
  if (link) {
    const actions = document.createElement("span");
    actions.className = "row-actions";
    const a = document.createElement("a");
    a.className = "link-button";
    a.href = link.href;
    a.textContent = link.text;
    actions.append(a, button);
    li.append(text, actions);
  } else {
    li.append(text, button);
  }
  return li;
}

function emptyRow(text) {
  const li = document.createElement("li");
  li.className = "empty";
  li.textContent = text;
  return li;
}

async function renderPrefs() {
  $("autoload").checked = (await getSettings()).autoload;
}

async function renderData() {
  const stats = await send({ type: "GET_STATS" });
  if (!stats.ok) return;
  const sets = stats.fieldSets.map((fs) =>
    row(fs.origin, `${fs.count}項目・${absoluteTime(fs.updatedAt)} 更新`, "消去", async () => {
      await send({ type: "CLEAR_FIELD_SET", origin: fs.origin });
      renderData();
    }, { confirm: true, link: { text: "編集", href: `saved-fields.html?origin=${encodeURIComponent(fs.origin)}` } })
  );
  $("field-sets").replaceChildren(...(sets.length ? sets : [emptyRow("ありません。ポップアップの「すべてのフィールドを保存」で保存できます。")]));
}

$("autoload").addEventListener("change", (e) => setSettings({ autoload: e.target.checked }));

// ポップアップでオートロードを切り替えたときに追随する。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[SETTINGS_KEY]) renderPrefs();
});

renderPrefs();
renderData();
