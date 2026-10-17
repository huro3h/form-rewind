// 入力欄の列挙・値の読み書き・保存した欄と今のページの欄の突き合わせ。
// content script の各フレームで読まれる。
(() => {
  "use strict";

  const UI_HOST_ID = "form-rewind-ui";
  const SHADOW = "#shadow";
  const FIELD_SELECTOR = "input, textarea, select, [contenteditable]";
  const UNSAVED_INPUT_TYPES = new Set(["password", "hidden", "file", "submit", "button", "reset", "image"]);
  const PASSWORD_AUTOCOMPLETE = /(^|\s)(current-password|new-password)(\s|$)/i;
  const SEARCH_NAME = /^(q|s|query|search|keyword|keywords)$/i;
  const AUTO_ID = /\d{3,}|^:.*:$|[0-9a-f]{8,}|^(ember|react|radix|headlessui|mui|rc|__)[-_:]/i;
  const LABEL_MAX = 80;
  const BLOCKED_TAGS = "script, style, iframe, frame, object, embed, link, meta, base";
  const BLOCK_TAGS = "p, div, li, h1, h2, h3, h4, h5, h6, tr, blockquote, pre";

  // ---- 位置(パス) ----
  // XPath ではなく「タグ名[同名兄弟の何番目か]」の並びにする。shadow root をまたぐ所には #shadow を挟む。

  function segmentOf(el) {
    let index = 1;
    for (let s = el.previousElementSibling; s; s = s.previousElementSibling) {
      if (s.tagName === el.tagName) index++;
    }
    return `${el.tagName.toLowerCase()}[${index}]`;
  }

  function pathOf(el) {
    const parts = [];
    let node = el;
    while (node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        parts.unshift(segmentOf(node));
        node = node.parentNode;
      } else if (node instanceof ShadowRoot) {
        parts.unshift(SHADOW);
        node = node.host;
      } else {
        break;
      }
    }
    return parts.join("/");
  }

  function elementAt(path) {
    if (!path) return null;
    let node = document;
    for (const part of path.split("/")) {
      if (part === SHADOW) {
        node = node.shadowRoot;
      } else {
        const m = /^([a-z0-9-]+)\[(\d+)\]$/.exec(part);
        if (!m) return null;
        let count = 0;
        let found = null;
        for (const child of node.children) {
          if (child.tagName.toLowerCase() === m[1] && ++count === Number(m[2])) {
            found = child;
            break;
          }
        }
        node = found;
      }
      if (!node) return null;
    }
    return node.nodeType === Node.ELEMENT_NODE ? node : null;
  }

  // ---- 列挙 ----

  function queryAllDeep(root, out = []) {
    root.querySelectorAll(FIELD_SELECTOR).forEach((el) => out.push(el));
    root.querySelectorAll("*").forEach((el) => {
      if (el.shadowRoot && el.id !== UI_HOST_ID) queryAllDeep(el.shadowRoot, out);
    });
    return out;
  }

  function typeOf(el) {
    return el.tagName === "INPUT" ? (el.type || "text").toLowerCase() : "";
  }

  function isRichRoot(el) {
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return false;
    if (!el.isContentEditable) return false;
    const parent = el.parentElement;
    return !(parent && parent.isContentEditable);
  }

  function isPasswordField(el) {
    return typeOf(el) === "password" || PASSWORD_AUTOCOMPLETE.test(el.getAttribute("autocomplete") || "");
  }

  // 安全のためではなく、検索するたびに履歴が増えて復元バナーが出るのを防ぐために外す。
  function isSearchField(el) {
    if (typeOf(el) === "search" || el.getAttribute("role") === "searchbox") return true;
    if (el.closest('[role="search"]')) return true;
    return SEARCH_NAME.test(el.getAttribute("name") || "") || SEARCH_NAME.test(el.id || "");
  }

  function isTarget(el) {
    if (el.tagName === "INPUT") {
      if (UNSAVED_INPUT_TYPES.has(typeOf(el))) return false;
    } else if (el.tagName !== "TEXTAREA" && el.tagName !== "SELECT" && !isRichRoot(el)) {
      return false;
    }
    return !isPasswordField(el) && !isSearchField(el);
  }

  function allFields() {
    return queryAllDeep(document).filter(isTarget);
  }

  // ---- ラベル ----

  function cleanText(node) {
    return (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, LABEL_MAX);
  }

  function findLabel(el) {
    const root = el.getRootNode();
    if (el.id && root.querySelector) {
      const label = root.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return cleanText(label);
    }
    const wrapping = el.closest("label");
    if (wrapping) return cleanText(wrapping);
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim().slice(0, LABEL_MAX);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy && root.getElementById) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => root.getElementById(id))
        .filter(Boolean)
        .map(cleanText)
        .join(" ")
        .trim();
      if (text) return text.slice(0, LABEL_MAX);
    }
    const cell = el.closest("td, dd");
    if (cell) {
      let head = cell.previousElementSibling;
      while (head && head.tagName !== "TH" && head.tagName !== "DT") head = head.previousElementSibling;
      if (head && !head.querySelector(FIELD_SELECTOR)) return cleanText(head);
    }
    const placeholder = el.getAttribute("placeholder");
    return placeholder ? placeholder.trim().slice(0, LABEL_MAX) : "";
  }

  // ---- 値 ----

  function readValue(el) {
    const type = typeOf(el);
    if (type === "checkbox" || type === "radio") return { checked: el.checked, value: el.value };
    if (el.tagName === "SELECT") {
      if (el.multiple) return { values: Array.from(el.selectedOptions, (o) => o.value) };
      const opt = el.selectedOptions[0];
      return { value: el.value, text: opt ? opt.text.trim() : "" };
    }
    if (isRichRoot(el)) return { value: el.innerHTML, rich: true };
    return { value: el.value };
  }

  // ページの初期値から変わっているか。保存するかどうかの判定に使う
  // (既定でチェック済みの欄があるだけのページで履歴を作らないため)。
  function isChanged(el) {
    const type = typeOf(el);
    if (type === "checkbox" || type === "radio") return el.checked !== el.defaultChecked;
    if (el.tagName === "SELECT") {
      // selected 属性が1つもなければ、単一選択は先頭が初期値(defaultSelected は全部 false になる)。
      const options = Array.from(el.options);
      const hasDefault = options.some((o) => o.defaultSelected);
      return options.some((o, i) => o.selected !== (hasDefault ? o.defaultSelected : !el.multiple && i === 0));
    }
    if (isRichRoot(el)) return el.textContent.trim() !== "";
    return el.value.trim() !== "" && el.value !== el.defaultValue;
  }

  function describe(el, nameIndex, nameCount) {
    return {
      path: pathOf(el),
      tag: el.tagName,
      type: typeOf(el),
      name: el.getAttribute("name") || "",
      id: el.id || "",
      label: findLabel(el),
      nameIndex,
      nameCount,
      ...readValue(el),
    };
  }

  function groupKey(tag, type, name, value) {
    const choice = type === "checkbox" || type === "radio";
    return [tag, type, name, choice ? value : ""].join("|");
  }

  function keyOfElement(el) {
    return groupKey(el.tagName, typeOf(el), el.getAttribute("name") || "", el.value);
  }

  function keyOfStored(f) {
    return groupKey(f.tag, f.type || "", f.name || "", f.value ?? "");
  }

  // 今のページの全欄を保存用の形にする。同じ name の欄が並ぶ場合に備え、何番目かも持たせる。
  function collect() {
    const els = allFields();
    const totals = new Map();
    els.forEach((el) => totals.set(keyOfElement(el), (totals.get(keyOfElement(el)) || 0) + 1));
    const seen = new Map();
    return {
      changed: els.some(isChanged),
      items: els.map((el) => {
        const key = keyOfElement(el);
        const index = seen.get(key) || 0;
        seen.set(key, index + 1);
        return { el, field: describe(el, index, totals.get(key)) };
      }),
    };
  }

  // 空欄扱いか。文字の欄は空かどうか、選択式の欄は初期状態から動いていないかで見る。
  function isFilled(el) {
    const type = typeOf(el);
    if (type === "checkbox" || type === "radio" || el.tagName === "SELECT") return isChanged(el);
    if (isRichRoot(el)) return el.textContent.trim() !== "";
    return el.value !== "";
  }

  function isRendered(el) {
    return el.getClientRects().length > 0;
  }

  // ---- 突き合わせ ----
  // DOM が組み変わっていても戻せるよう、パス → 固定 id → name(+何番目か) → ラベルの順に探す。

  function sameKind(el, f) {
    return el.tagName === f.tag && typeOf(el) === (f.type || "");
  }

  function sameField(el, f) {
    if (!sameKind(el, f)) return false;
    const name = el.getAttribute("name") || "";
    if (f.name && name && f.name !== name) return false;
    if ((f.type === "checkbox" || f.type === "radio") && el.value !== f.value) return false;
    return true;
  }

  function matchElements(stored, candidates = allFields()) {
    const result = new Array(stored.length).fill(null);
    const used = new Set();
    const assign = (i, el) => {
      if (!el || used.has(el)) return;
      used.add(el);
      result[i] = el;
    };
    const groups = new Map();
    candidates.forEach((el) => {
      const key = keyOfElement(el);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(el);
    });

    const candidateSet = new Set(candidates);
    stored.forEach((f, i) => {
      const el = elementAt(f.path);
      if (el && candidateSet.has(el) && sameField(el, f)) assign(i, el);
    });
    stored.forEach((f, i) => {
      if (result[i] || !f.id || AUTO_ID.test(f.id)) return;
      const hits = candidates.filter((el) => !used.has(el) && el.id === f.id && sameKind(el, f));
      if (hits.length === 1) assign(i, hits[0]);
    });
    // 同じ name の欄の数が保存時と同じなら「何番目か」で、1つしかなければそれに当てる。
    stored.forEach((f, i) => {
      if (result[i] || !f.name) return;
      const group = groups.get(keyOfStored(f)) || [];
      if (f.nameCount === group.length) assign(i, group[f.nameIndex]);
      else if (group.length === 1) assign(i, group[0]);
    });
    stored.forEach((f, i) => {
      if (result[i] || !f.label) return;
      const hits = candidates.filter((el) => !used.has(el) && sameKind(el, f) && findLabel(el) === f.label);
      if (hits.length === 1) assign(i, hits[0]);
    });
    return result;
  }

  // ---- 書き込み ----

  function sanitizeHtml(html) {
    const doc = new DOMParser().parseFromString(String(html), "text/html");
    doc.querySelectorAll(BLOCKED_TAGS).forEach((n) => n.remove());
    doc.body.querySelectorAll("*").forEach((n) => {
      for (const attr of Array.from(n.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on") || /^\s*(javascript|vbscript|data:text\/html)/i.test(attr.value)) {
          n.removeAttribute(attr.name);
        }
      }
    });
    return doc.body.innerHTML;
  }

  function htmlToText(html) {
    const doc = new DOMParser().parseFromString(String(html), "text/html");
    doc.body.querySelectorAll("br").forEach((n) => n.replaceWith("\n"));
    doc.body.querySelectorAll(BLOCK_TAGS).forEach((n) => n.append("\n"));
    return doc.body.textContent.replace(/\n{3,}/g, "\n\n").trim();
  }

  function fire(el, ...types) {
    types.forEach((type) => el.dispatchEvent(new Event(type, { bubbles: true })));
  }

  // React などはプロトタイプの setter を経由しないと値の変化に気づかない。
  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    fire(el, "input", "change");
  }

  // チェックは click() で切り替える。checked を直接書いて click を送ると React 側で二重に反転する。
  function setChecked(el, checked) {
    if (el.checked !== checked) el.click();
  }

  function selectOption(el, f) {
    let opt = Array.from(el.options).find((o) => o.value === f.value);
    if (!opt && f.text) opt = Array.from(el.options).find((o) => o.text.trim() === f.text);
    if (!opt) return false;
    if (!opt.selected) {
      el.value = opt.value;
      fire(el, "input", "change");
    }
    return true;
  }

  function writeValue(el, f) {
    const type = typeOf(el);
    if (type === "checkbox") {
      setChecked(el, !!f.checked);
    } else if (type === "radio") {
      if (f.checked) setChecked(el, true);
    } else if (el.tagName === "SELECT") {
      if (f.values) {
        const want = new Set(f.values);
        Array.from(el.options).forEach((o) => (o.selected = want.has(o.value)));
        fire(el, "input", "change");
      } else {
        return selectOption(el, f);
      }
    } else if (isRichRoot(el)) {
      el.innerHTML = sanitizeHtml(f.value ?? "");
      fire(el, "input");
    } else {
      setNativeValue(el, f.value ?? "");
    }
    return true;
  }

  // 書き込む前に呼び、元に戻す関数を返す。ラジオは「前にチェックされていた方」を戻す必要がある。
  function captureUndo(el) {
    if (typeOf(el) === "radio") {
      const scope = el.form || el.getRootNode();
      const group = el.name
        ? Array.from(scope.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`))
        : [el];
      const prev = group.find((r) => r.checked) || null;
      return () => {
        if (prev) {
          setChecked(prev, true);
        } else if (el.checked) {
          el.checked = false;
          fire(el, "input", "change");
        }
      };
    }
    const before = { tag: el.tagName, type: typeOf(el), ...readValue(el) };
    return () => writeValue(el, before);
  }

  // 一覧や差分で見せる文字列。
  function displayOf(f) {
    if (f.values) return f.values.join(", ");
    if (f.checked !== undefined) return f.checked ? "オン" : "オフ";
    if (f.tag === "SELECT") return f.text ?? f.value ?? "";
    if (f.rich) return htmlToText(f.value ?? "");
    return f.value ?? "";
  }

  window.FormRewindFields = {
    UI_HOST_ID,
    FIELD_SELECTOR,
    allFields,
    collect,
    matchElements,
    isChanged,
    isFilled,
    isRendered,
    readValue,
    writeValue,
    captureUndo,
    displayOf,
    displayOfElement: (el) => displayOf({ tag: el.tagName, ...readValue(el) }),
  };
})();
