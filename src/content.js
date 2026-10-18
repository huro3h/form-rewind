// 各フレームで動く本体。入力の自動保存、復元バナー、復元・差分の受け口、
// 「すべてのフィールドを保存/読み込み/消去」とオートロード。
(() => {
  "use strict";

  const F = window.FormRewindFields;
  const UI = window.FormRewindUI;
  const IS_TOP = window === window.top;
  const SETTINGS_KEY = globalThis.FORM_REWIND_SETTINGS_KEY;
  const DEBOUNCE_MS = 1000;
  const MAX_WAIT_MS = 10000;
  const BANNER_RETRY_MS = [1500, 4000];
  const AUTOLOAD_DEBOUNCE_MS = 300;

  let settings = { ...globalThis.FORM_REWIND_DEFAULTS };
  let pageKey = currentPageKey();
  let saveTimer = null;
  let pendingSince = 0;
  let lastSignature = "";
  let bannerDismissed = false;
  let toastShown = false;
  // 拡張機能自身が値を書き込んでいる間は、それを入力とみなして履歴を作らない。
  let writing = 0;

  let fieldSet = null; // このオリジンの「すべてのフィールドを保存」の中身(entries)
  let autoFilled = new WeakSet(); // オートロードで一度処理した欄。二度入れない
  // このページを開いてから読み込んだ欄(手動・オートロードとも)。バッジの件数にする。同じ欄は1回だけ数える。
  const loadedEls = new WeakSet();
  let loadedCount = 0;
  let autoloadTimer = null;
  let observer = null;

  function currentPageKey() {
    return location.origin + location.pathname;
  }

  // 拡張機能の更新後は古いページから送れなくなる(context invalidated)。黙って諦める。
  async function send(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch {
      return null;
    }
  }

  function withWriting(fn) {
    writing++;
    try {
      return fn();
    } finally {
      writing--;
    }
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const sameDay = d.toDateString() === new Date().toDateString();
    const time = d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
    return sameDay ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
  }

  // ---- 自動保存 ----

  // iframe ではタブのドメインが分からないので、判定は service worker に任せる。
  function isPausedHere() {
    return IS_TOP && !globalThis.FORM_REWIND_AUTOSAVES(settings, location.hostname);
  }

  function scheduleSave() {
    if (writing) return;
    checkUrl();
    if (isPausedHere()) return;
    const now = Date.now();
    if (!pendingSince) pendingSince = now;
    clearTimeout(saveTimer);
    // 打ち続けていても MAX_WAIT_MS ごとには必ず保存する。
    saveTimer = setTimeout(saveNow, Math.max(0, Math.min(DEBOUNCE_MS, MAX_WAIT_MS - (now - pendingSince))));
  }

  function signatureOf(fields) {
    return JSON.stringify(fields.map((f) => [f.path, f.value ?? "", f.checked ?? "", f.values ?? ""]));
  }

  async function saveNow({ keep = false } = {}) {
    clearTimeout(saveTimer);
    pendingSince = 0;
    checkUrl();
    if (isPausedHere()) return;
    const { changed, items } = F.collect();
    if (!changed) return;
    const fields = items.map((i) => i.field);
    const sig = signatureOf(fields);
    if (sig === lastSignature && !keep) return;
    const res = await send({
      type: "SAVE_SNAPSHOT",
      snapshot: { pageKey, domain: location.hostname, url: location.href, title: document.title, fields, keep },
    });
    if (!res || !res.ok) return;
    lastSignature = sig;
    if (!keep && IS_TOP && settings.showToast && !toastShown) {
      toastShown = true;
      UI.showToast("入力内容を自動で保存しています");
    }
  }

  function flushSave() {
    if (pendingSince) saveNow();
  }

  // ---- URL の変化(SPA) ----

  function checkUrl() {
    const next = currentPageKey();
    if (next === pageKey) return;
    pageKey = next;
    lastSignature = "";
    bannerDismissed = false;
    toastShown = false;
    UI.hideBanner();
    refreshBanner();
  }

  // ---- 復元バナー ----

  async function refreshBanner(attempt = 0) {
    if (!IS_TOP || bannerDismissed) return;
    const res = await send({ type: "GET_LATEST", pageKey });
    if (!res || !res.ok || !res.latest) return;
    const { timestamp, count, topFields, hasFrames } = res.latest;
    // 今のページにすでに同じ内容が入っているなら出さない(送信後に戻ってきた場合など)。
    let differs = hasFrames;
    if (!differs && topFields) {
      const els = F.matchElements(topFields);
      if (els.every((el) => !el)) {
        // フォームを後から描くページのために少し待って見直す。
        if (attempt < BANNER_RETRY_MS.length) setTimeout(() => refreshBanner(attempt + 1), BANNER_RETRY_MS[attempt]);
        return;
      }
      differs = topFields.some((f, i) => els[i] && F.displayOf(f) !== F.displayOfElement(els[i]));
    }
    if (!differs || bannerDismissed) return;
    UI.showBanner({
      when: formatTime(timestamp),
      count,
      onDismiss: () => {
        bannerDismissed = true;
      },
      onRestore: async () => {
        bannerDismissed = true;
        const r = await send({ type: "RESTORE_LATEST", pageKey });
        if (!r || !r.ok) UI.showToast("復元できませんでした。ページを再読み込みしてお試しください");
      },
    });
  }

  // ---- 復元 ----

  function writeAll(pairs) {
    const undos = [];
    let applied = 0;
    withWriting(() => {
      pairs.forEach(([el, f]) => {
        const undo = F.captureUndo(el);
        if (F.writeValue(el, f)) {
          undos.push(undo);
          applied++;
        }
      });
    });
    const undoAll = () => {
      withWriting(() => undos.reverse().forEach((fn) => fn()));
      UI.showToast("元に戻しました");
    };
    return { applied, undoAll };
  }

  async function restore(fields, onlyPaths) {
    // 上書きされる今の入力も履歴に残しておく(元に戻すのを押し損ねても取り戻せるように)。
    await saveNow({ keep: true });
    const only = onlyPaths ? new Set(onlyPaths) : null;
    const targets = fields.filter((f) => !only || only.has(f.path));
    const els = F.matchElements(targets);
    const pairs = targets.map((f, i) => [els[i], f]).filter(([el]) => el);
    const missing = targets.length - pairs.length;
    const { applied, undoAll } = writeAll(pairs);
    lastSignature = "";
    UI.hideBanner();
    if (!applied) {
      UI.showToast("復元できる入力欄が見つかりませんでした");
    } else {
      const note = missing ? `(見つからなかった項目: ${missing})` : "";
      UI.showToast(`${applied}項目を復元しました${note}`, { onUndo: undoAll });
    }
    return { applied, missing };
  }

  // ---- すべてのフィールドを保存 / 読み込み / 消去 ----
  // AutoFormer+ と同じく、オリジンごとに「フォーム名@欄の名前」をキーにして1組だけ持つ。
  // URL をキーに含めないので、同じサイトの別ページでも name が同じ欄なら読み込める。

  function setKeyOf(el, f) {
    const form = el.form ? el.form.getAttribute("name") || el.form.id || "" : "";
    const ident = f.name || f.id || (f.label ? `label:${f.label}` : `path:${pageKey}|${f.path}`);
    const choice = f.type === "checkbox" || f.type === "radio" ? `=${f.value}` : "";
    return `${form}@${f.tag}:${f.type}@${ident}${choice}`;
  }

  function entryOf(f) {
    const { tag, type, value, checked, values, text, rich, label } = f;
    return { tag, type, value, checked, values, text, rich, label };
  }

  // 保存対象: 文字が入った欄・チェックボックス(オンもオフも)・チェックされたラジオ・セレクト。
  function savableItems() {
    return F.collect().items.filter(({ el, field: f }) => {
      if (!F.isRendered(el)) return false;
      if (f.type === "radio") return f.checked;
      if (f.type === "checkbox" || f.tag === "SELECT") return true;
      return F.displayOf(f).trim() !== "";
    });
  }

  async function saveFieldSet() {
    const items = savableItems();
    if (!items.length) {
      if (IS_TOP && !document.querySelector("iframe, frame")) UI.showToast("保存できる項目がありません");
      return;
    }
    const entries = {};
    const radioGroups = [];
    items.forEach(({ el, field }) => {
      const key = setKeyOf(el, field);
      entries[key] = entryOf(field);
      // 同じグループで前回チェックしていたラジオの記録は消す。残すと読み込み時にどちらが勝つか決まらない。
      if (field.type === "radio") radioGroups.push({ keep: key, prefix: key.slice(0, key.lastIndexOf("=") + 1) });
    });
    const res = await send({ type: "SAVE_FIELD_SET", origin: location.origin, entries, radioGroups });
    if (!res || !res.ok) {
      UI.showToast("保存できませんでした");
      return;
    }
    fieldSet = res.entries;
    UI.showToast(`${items.length}項目を保存しました`);
    startAutoloadObserver();
  }

  async function fetchFieldSet() {
    const res = await send({ type: "GET_FIELD_SET", origin: location.origin });
    fieldSet = res && res.ok && res.entries && Object.keys(res.entries).length ? res.entries : null;
    return fieldSet;
  }

  function loadFieldSet({ onlyEmpty = false, auto = false } = {}) {
    if (!fieldSet) return 0;
    const pairs = [];
    F.collect().items.forEach(({ el, field }) => {
      const entry = fieldSet[setKeyOf(el, field)];
      if (!entry) return;
      if (auto) {
        // 編集画面で「自動」を外した欄は、手動の読み込みでだけ入れる。
        if (entry.auto === false) return;
        // オートロードは一度だけ、しかも空欄にだけ入れる。打った内容を後から上書きしないため。
        if (autoFilled.has(el)) return;
        autoFilled.add(el);
        if (F.isFilled(el)) return;
      } else if (onlyEmpty && F.isFilled(el)) {
        return;
      }
      if (entry.type === "radio" && !entry.checked) return;
      if (F.displayOf(entry) === F.displayOfElement(el)) return;
      pairs.push([el, entry]);
    });
    const { applied, undoAll } = writeAll(pairs);
    reportLoaded(pairs.map(([el]) => el));
    if (applied) {
      const what = auto ? "保存したフィールドを" : "";
      UI.showToast(`${what}${applied}項目を読み込みました`, { onUndo: undoAll });
    }
    return applied;
  }

  function reportLoaded(els) {
    const before = loadedCount;
    els.forEach((el) => {
      if (loadedEls.has(el)) return;
      loadedEls.add(el);
      loadedCount++;
    });
    if (loadedCount !== before) send({ type: "FIELDS_LOADED", count: loadedCount });
  }

  async function loadFieldSetManually(onlyEmpty) {
    await fetchFieldSet();
    if (!fieldSet) {
      if (IS_TOP) UI.showToast("このサイトに保存したフィールドはありません");
      return;
    }
    const applied = loadFieldSet({ onlyEmpty });
    if (!applied && IS_TOP) UI.showToast("読み込める項目がありませんでした");
  }

  async function clearFieldSet() {
    const res = await send({ type: "CLEAR_FIELD_SET", origin: location.origin });
    fieldSet = null;
    stopAutoloadObserver();
    if (IS_TOP) UI.showToast(res && res.ok ? "このサイトの保存したフィールドを消去しました" : "消去できませんでした");
  }

  // ---- オートロード ----

  function scheduleAutoload() {
    clearTimeout(autoloadTimer);
    autoloadTimer = setTimeout(() => loadFieldSet({ auto: true }), AUTOLOAD_DEBOUNCE_MS);
  }

  function addsField(node) {
    return node.nodeType === Node.ELEMENT_NODE && (node.matches(F.FIELD_SELECTOR) || node.querySelector(F.FIELD_SELECTOR));
  }

  // 後から描かれるフォーム(SPA・モーダル)にも入れるため、入力欄が足されたら読み込み直す。
  function startAutoloadObserver() {
    if (!settings.autoload || !fieldSet || observer) return;
    observer = new MutationObserver((mutations) => {
      if (mutations.some((m) => Array.from(m.addedNodes).some(addsField))) scheduleAutoload();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function stopAutoloadObserver() {
    observer?.disconnect();
    observer = null;
    clearTimeout(autoloadTimer);
  }

  async function initAutoload() {
    if (!settings.autoload) return;
    if (!(await fetchFieldSet())) return;
    loadFieldSet({ auto: true });
    startAutoloadObserver();
  }

  // ---- 受け口 ----

  // ポップアップからの復元・差分はフレームを pageKey で指定してくる。違うフレームは黙る。
  function isForOtherFrame(msg) {
    return !!msg.targetPageKey && msg.targetPageKey !== pageKey;
  }

  // 応答しないと送り手(ポップアップ)の Promise が「応答なし」で reject されるので、受けたら必ず返す。
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg && msg.type) {
      case "RESTORE":
        if (isForOtherFrame(msg)) return false;
        restore(msg.fields, msg.onlyPaths).then(sendResponse);
        return true;
      case "GET_CURRENT": {
        if (isForOtherFrame(msg)) return false;
        const els = F.matchElements(msg.fields);
        sendResponse({
          stored: msg.fields.map(F.displayOf),
          current: els.map((el) => (el ? F.displayOfElement(el) : null)),
        });
        return false;
      }
      case "FIELD_SET_SAVE":
        saveFieldSet();
        sendResponse({ ok: true });
        return false;
      case "FIELD_SET_LOAD":
        loadFieldSetManually(!!msg.onlyEmpty);
        sendResponse({ ok: true });
        return false;
      case "FIELD_SET_CLEAR":
        clearFieldSet();
        sendResponse({ ok: true });
        return false;
      default:
        return false;
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[SETTINGS_KEY]) return;
    settings = { ...globalThis.FORM_REWIND_DEFAULTS, ...changes[SETTINGS_KEY].newValue };
    if (!settings.autoload) stopAutoloadObserver();
  });

  document.addEventListener("input", scheduleSave, true);
  document.addEventListener("change", scheduleSave, true);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSave();
  });
  window.addEventListener("pagehide", flushSave);
  window.addEventListener("popstate", checkUrl);
  if (window.navigation) window.navigation.addEventListener("navigatesuccess", checkUrl);

  (async () => {
    try {
      const stored = await chrome.storage.local.get(SETTINGS_KEY);
      settings = { ...globalThis.FORM_REWIND_DEFAULTS, ...stored[SETTINGS_KEY] };
    } catch {
      return; // 拡張機能が更新・削除された直後の古いページ
    }
    // オートロードを先に済ませ、それでもなお差があるときだけバナーを出す。
    await initAutoload();
    refreshBanner();
  })();
})();
