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
  const s = await getSettings();
  const form = $("prefs");
  form.elements.autosave.checked = s.autosave;
  form.elements.showToast.checked = s.showToast;
  form.elements.autoload.checked = s.autoload;
  form.elements.maxPerPage.value = s.maxPerPage;
  form.elements.retentionDays.value = s.retentionDays;

  // 全体の自動保存がオンなら一時停止しているサイト、オフなら自動保存するサイトを並べる。
  const key = s.autosave ? "pausedDomains" : "enabledDomains";
  $("sites-title").textContent = s.autosave ? "自動保存を一時停止しているサイト" : "自動保存するサイト";
  const sites = s[key].map((domain) =>
    row(domain, "", s.autosave ? "再開" : "外す", async () => {
      const current = await getSettings();
      await setSettings({ [key]: current[key].filter((d) => d !== domain) });
      renderPrefs();
    })
  );
  const empty = s.autosave ? "ありません。ポップアップから一時停止できます。" : "ありません。ポップアップから選べます。";
  $("sites").replaceChildren(...(sites.length ? sites : [emptyRow(empty)]));
}

async function renderData() {
  const stats = await send({ type: "GET_STATS" });
  if (!stats.ok) return;
  $("stats").textContent = `${stats.total}件(うち固定 ${stats.pinned}件)`;
  const domains = stats.domains.map((d) =>
    row(d.domain, `${d.count}件`, "このサイトの履歴を削除", async () => {
      await send({ type: "DELETE_DOMAIN_HISTORY", domain: d.domain });
      renderData();
    }, { confirm: true })
  );
  $("domains").replaceChildren(...(domains.length ? domains : [emptyRow("履歴はまだありません。")]));

  const sets = stats.fieldSets.map((fs) =>
    row(fs.origin, `${fs.count}項目・${absoluteTime(fs.updatedAt)} 更新`, "消去", async () => {
      await send({ type: "CLEAR_FIELD_SET", origin: fs.origin });
      renderData();
    }, { confirm: true, link: { text: "編集", href: `saved-fields.html?origin=${encodeURIComponent(fs.origin)}` } })
  );
  $("field-sets").replaceChildren(...(sets.length ? sets : [emptyRow("ありません。ポップアップの「すべてのフィールドを保存」で保存できます。")]));
}

$("prefs").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const message = $("prefs-message");
  const maxPerPage = Number(form.elements.maxPerPage.value);
  const retentionDays = Number(form.elements.retentionDays.value);
  message.hidden = false;
  if (!Number.isInteger(maxPerPage) || maxPerPage < 1 || maxPerPage > 200 || !Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
    message.textContent = "件数は1〜200、日数は1〜365の整数で入力してください。";
    message.classList.add("error");
    return;
  }
  await setSettings({
    autosave: form.elements.autosave.checked,
    showToast: form.elements.showToast.checked,
    autoload: form.elements.autoload.checked,
    maxPerPage,
    retentionDays,
  });
  message.textContent = "保存しました。";
  message.classList.remove("error");
});

confirmButton($("delete-all"), "入力履歴をすべて削除", async () => {
  await send({ type: "DELETE_ALL_HISTORY" });
  renderData();
});

// ポップアップでサイトの自動保存を切り替えたときなどに追随する。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[SETTINGS_KEY]) renderPrefs();
});

renderPrefs();
renderData();
