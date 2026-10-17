"use strict";

// 「すべてのフィールドを保存」の中身を、サイトごとに表で見せて編集する画面。
// 編集は手元の draft に溜め、「保存」でまとめて書く。開いてからページ側で保存されていたら書かずに止める。

const DEFAULTS = globalThis.FORM_REWIND_DEFAULTS;
const SETTINGS_KEY = globalThis.FORM_REWIND_SETTINGS_KEY;
const CONFIRM_MS = 3000;
const MESSAGE_MS = 5000;

const TYPE_LABELS = {
  text: "テキスト",
  email: "メール",
  tel: "電話番号",
  number: "数値",
  url: "URL",
  date: "日付",
  "datetime-local": "日時",
  month: "年月",
  week: "週",
  time: "時刻",
  color: "色",
  range: "範囲",
  checkbox: "チェック",
  radio: "ラジオ",
};

const $ = (id) => document.getElementById(id);

let origin = null;
let baseUpdatedAt = null; // 読み込んだ時点の updatedAt。保存時の競合検出に使う
let saved = {}; // DB にある内容
let draft = {}; // 編集中の内容

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function absoluteTime(ts) {
  return new Date(ts).toLocaleString("ja-JP", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

let messageTimer = null;
function showMessage(text, isError = false) {
  const el = $("message");
  el.textContent = text;
  el.classList.toggle("error", isError);
  el.hidden = false;
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => (el.hidden = true), MESSAGE_MS);
}

// ---- キーの読み解き ----
// キーは content.js の setKeyOf が作る「フォーム名@タグ:type@名前(=チェック類の value)」。

function parseKey(key) {
  const m = /^(.*?)@([A-Z]+):([a-z-]*)@(.*)$/.exec(key);
  if (!m) return { form: "", type: "", ident: key, choice: "" };
  const [, form, , type] = m;
  let ident = m[4];
  let choice = "";
  if (type === "checkbox" || type === "radio") {
    const i = ident.lastIndexOf("=");
    if (i >= 0) {
      choice = ident.slice(i + 1);
      ident = ident.slice(0, i);
    }
  }
  return { form, type, ident, choice };
}

function describeIdent(ident) {
  if (ident.startsWith("label:")) return { title: ident.slice(6), how: "ラベルで照合" };
  if (ident.startsWith("path:")) return { title: "(名前のない欄)", how: `${ident.slice(5).split("|")[0]} の決まった位置` };
  return { title: ident, how: `name: ${ident}` };
}

function typeLabel(entry) {
  if (entry.rich) return "リッチテキスト";
  if (entry.tag === "TEXTAREA") return "複数行";
  if (entry.tag === "SELECT") return entry.values ? "複数選択" : "選択";
  return TYPE_LABELS[entry.type] || entry.type || "テキスト";
}

function displayValue(entry) {
  if (entry.values) return entry.values.join(", ");
  if (entry.checked !== undefined) return entry.checked ? "オン" : "オフ";
  if (entry.tag === "SELECT") return entry.text || entry.value || "";
  return entry.value ?? "";
}

// ---- 変更の追跡 ----

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function isDirty() {
  return !same(draft, saved);
}

function updateSavebar() {
  const dirty = isDirty();
  $("savebar").hidden = !dirty;
  // 未保存の編集があるとエクスポートに含まれず、インポートとは競合するので、その間は押せなくする。
  for (const id of ["export", "import"]) {
    $(id).disabled = dirty;
    $(id).title = dirty ? "先に保存するか元に戻してください" : "";
  }
  if (dirty) {
    const removed = Object.keys(saved).filter((k) => !(k in draft)).length;
    const edited = Object.keys(draft).filter((k) => !same(draft[k], saved[k])).length;
    const parts = [edited ? `${edited}項目を変更` : "", removed ? `${removed}項目を削除` : ""].filter(Boolean);
    $("savebar-text").textContent = `未保存の変更があります(${parts.join("・")})`;
  }
}

function markRow(tr, key) {
  tr.classList.toggle("edited", !same(draft[key], saved[key]));
  updateSavebar();
}

// ---- 値の編集欄 ----

function valueEditor(key, tr) {
  const entry = draft[key];
  const wrap = document.createElement("div");
  const note = (text) => {
    const p = document.createElement("div");
    p.className = "value-note";
    p.textContent = text;
    wrap.append(p);
  };
  const update = (patch) => {
    draft[key] = { ...draft[key], ...patch };
    markRow(tr, key);
  };

  if (entry.type === "checkbox") {
    const label = document.createElement("label");
    label.className = "check";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !!entry.checked;
    box.addEventListener("change", () => {
      update({ checked: box.checked });
      text.textContent = box.checked ? "オン" : "オフ";
    });
    const text = document.createElement("span");
    text.textContent = entry.checked ? "オン" : "オフ";
    label.append(box, text);
    wrap.append(label);
    return wrap;
  }

  if (entry.type === "radio") {
    const { choice } = parseKey(key);
    const span = document.createElement("span");
    span.textContent = `「${entry.label || choice}」を選ぶ`;
    wrap.append(span);
    note("選ぶ項目を変えるには、ページで選び直して保存し直してください");
    return wrap;
  }

  const multiline = entry.tag === "TEXTAREA" || entry.rich;
  const input = document.createElement(multiline ? "textarea" : "input");
  if (!multiline) input.type = "text";
  input.className = "value-input";
  input.value = displayValue(entry);
  input.setAttribute("aria-label", "値");
  if (multiline) input.rows = Math.min(8, Math.max(2, input.value.split("\n").length));
  input.addEventListener("input", () => {
    const v = input.value;
    if (entry.tag === "SELECT" && entry.values) {
      update({ values: v.split(/\s*,\s*/).filter(Boolean) });
    } else if (entry.tag === "SELECT") {
      // 表示名で選ぶ(読み込み側は value → 表示名の順で選択肢を探す)。
      update({ value: v, text: v });
    } else {
      update({ value: v });
    }
  });
  wrap.append(input);
  if (entry.tag === "SELECT") note(entry.values ? "選択肢の値をカンマ区切りで" : "選択肢の表示名");
  if (entry.rich) note("HTML のまま保存しています");
  return wrap;
}

// ---- 表 ----

function renderRows() {
  const tbody = $("rows");
  const query = $("filter").value.trim().toLowerCase();
  const rows = [];
  for (const key of Object.keys(draft)) {
    const entry = draft[key];
    const { form, ident } = parseKey(key);
    const { title, how } = describeIdent(ident);
    // ラジオのラベルは選択肢の名前(「B」など)なので、項目名には name を使い、ラベルは値の側に出す。
    const label = entry.type === "radio" ? title : entry.label || title;
    const haystack = [label, ident, form, displayValue(entry)].join(" ").toLowerCase();
    if (query && !haystack.includes(query)) continue;

    const tr = document.createElement("tr");
    tr.dataset.key = key;

    const typeCell = document.createElement("td");
    const chip = document.createElement("span");
    chip.className = "type-chip";
    chip.textContent = typeLabel(entry);
    typeCell.append(chip);

    const nameCell = document.createElement("td");
    const name = document.createElement("div");
    name.className = "field-label";
    name.textContent = label;
    const sub = document.createElement("div");
    sub.className = "field-key";
    sub.textContent = [how, form ? `フォーム: ${form}` : ""].filter(Boolean).join("・");
    nameCell.append(name, sub);

    const valueCell = document.createElement("td");
    valueCell.append(valueEditor(key, tr));

    const autoCell = document.createElement("td");
    autoCell.className = "col-auto";
    const auto = document.createElement("input");
    auto.type = "checkbox";
    auto.checked = entry.auto !== false;
    auto.title = "オートロードで入れる";
    auto.setAttribute("aria-label", `${label} をオートロードで入れる`);
    auto.addEventListener("change", () => {
      const next = { ...draft[key] };
      if (auto.checked) delete next.auto;
      else next.auto = false;
      draft[key] = next;
      markRow(tr, key);
    });
    autoCell.append(auto);

    const removeCell = document.createElement("td");
    removeCell.className = "col-remove";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove";
    remove.textContent = "×";
    remove.title = "この項目を削除";
    remove.setAttribute("aria-label", `${label} を削除`);
    remove.addEventListener("click", () => {
      delete draft[key];
      renderRows();
      updateSavebar();
    });
    removeCell.append(remove);

    tr.append(typeCell, nameCell, valueCell, autoCell, removeCell);
    tr.classList.toggle("edited", !same(draft[key], saved[key]));
    rows.push(tr);
  }
  tbody.replaceChildren(...rows);
  $("no-match").hidden = rows.length > 0 || Object.keys(draft).length === 0;
}

function renderMeta() {
  $("origin").textContent = origin;
  const count = Object.keys(saved).length;
  const autoCount = Object.values(saved).filter((e) => e.auto !== false).length;
  $("meta").textContent = baseUpdatedAt
    ? `${count}項目(うちオートロード ${autoCount}項目)・${absoluteTime(baseUpdatedAt)} 更新`
    : "保存した項目はありません";
}

// ---- サイト ----

async function loadSite(nextOrigin) {
  const res = await send({ type: "GET_FIELD_SET", origin: nextOrigin });
  if (!res.ok) {
    showMessage("読み込めませんでした。", true);
    return;
  }
  origin = nextOrigin;
  baseUpdatedAt = res.updatedAt;
  saved = res.entries || {};
  draft = structuredClone(saved);
  history.replaceState(null, "", `?origin=${encodeURIComponent(origin)}`);
  document.querySelectorAll("#sites button").forEach((b) => b.setAttribute("aria-current", String(b.dataset.origin === origin)));
  $("editor").hidden = false;
  renderMeta();
  renderRows();
  updateSavebar();
}

async function renderSites(preferred) {
  const stats = await send({ type: "GET_STATS" });
  const sets = stats.ok ? stats.fieldSets : [];
  $("sites").replaceChildren(
    ...sets.map((fs) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.origin = fs.origin;
      const name = document.createElement("span");
      name.className = "site-name";
      name.textContent = fs.origin.replace(/^https?:\/\//, "");
      const count = document.createElement("span");
      count.className = "site-count";
      count.textContent = String(fs.count);
      button.append(name, count);
      button.addEventListener("click", () => {
        if (fs.origin === origin) return;
        if (isDirty()) {
          showMessage("未保存の変更があります。保存するか元に戻してから切り替えてください。", true);
          return;
        }
        loadSite(fs.origin);
      });
      li.append(button);
      return li;
    })
  );
  $("no-sites").hidden = sets.length > 0;
  const target = sets.find((fs) => fs.origin === preferred) || sets[0];
  if (target) await loadSite(target.origin);
  else $("editor").hidden = true;
}

// ---- 操作 ----

$("filter").addEventListener("input", renderRows);

$("save").addEventListener("click", async () => {
  const res = await send({ type: "PUT_FIELD_SET", origin, entries: draft, baseUpdatedAt });
  if (!res.ok) {
    if (res.error === "CONFLICT") {
      showMessage("開いてから、このサイトの保存内容がページ側で更新されました。「元に戻す」で最新を読み込んでから編集し直してください。", true);
    } else {
      showMessage("保存できませんでした。", true);
    }
    return;
  }
  showMessage("保存しました。次にページを開いたときから反映されます。");
  if (Object.keys(draft).length === 0) {
    saved = {};
    await renderSites(null);
    return;
  }
  await renderSites(origin);
});

// 元に戻す = DB から読み直す(競合のあとに最新を取り直すのも兼ねる)。
$("revert").addEventListener("click", () => loadSite(origin));

let deleteArmed = null;
$("delete-site").addEventListener("click", async () => {
  const button = $("delete-site");
  if (!deleteArmed) {
    button.textContent = "もう一度押すと消去します";
    deleteArmed = setTimeout(() => {
      deleteArmed = null;
      button.textContent = "このサイトの分をすべて消去";
    }, CONFIRM_MS);
    return;
  }
  clearTimeout(deleteArmed);
  deleteArmed = null;
  button.textContent = "このサイトの分をすべて消去";
  await send({ type: "CLEAR_FIELD_SET", origin });
  saved = {};
  draft = {};
  showMessage(`${origin} の保存したフィールドを消去しました。`);
  await renderSites(null);
});

// ---- エクスポート / インポート ----

const IMPORT_ERRORS = {
  FORMAT: "Form Rewind の「保存したフィールド」のファイルではないか、中身が壊れています。",
  VERSION: "このバージョンでは読めない形式のファイルです。",
  TOO_LARGE: "ファイルが大きすぎます。",
};

function dateStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

$("export").addEventListener("click", async () => {
  const res = await send({ type: "EXPORT_FIELD_SETS" });
  if (!res.ok || !res.data.sites.length) {
    showMessage(res.ok ? "エクスポートするものがありません。" : "エクスポートできませんでした。", !res.ok);
    return;
  }
  const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `form-rewind-fields-${dateStamp()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  const count = res.data.sites.reduce((n, s) => n + Object.keys(s.entries).length, 0);
  showMessage(`${res.data.sites.length}サイト・${count}項目をエクスポートしました。`);
});

$("import").addEventListener("click", () => $("import-file").click());

$("import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = ""; // 同じファイルを続けて選んでも change が来るように
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    showMessage("JSON として読めませんでした。", true);
    return;
  }
  const res = await send({ type: "IMPORT_FIELD_SETS", data });
  if (!res.ok) {
    showMessage(IMPORT_ERRORS[res.error] || "インポートできませんでした。", true);
    return;
  }
  showMessage(`${res.sites}サイト・${res.entries}項目をインポートしました(同じ項目は上書き)。`);
  await renderSites(origin);
});

window.addEventListener("beforeunload", (e) => {
  if (isDirty()) e.preventDefault();
});

async function renderAutoloadNotice() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  $("autoload-off").hidden = { ...DEFAULTS, ...stored[SETTINGS_KEY] }.autoload;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[SETTINGS_KEY]) renderAutoloadNotice();
});

renderAutoloadNotice();
renderSites(new URLSearchParams(location.search).get("origin"));
