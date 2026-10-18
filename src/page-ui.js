// ページ右下に出す通知。ページの CSS と混ざらないよう shadow root に描く。
// open にしているのは E2E から押すため。中身は項目数だけで、ページに読まれて困るものはない。
(() => {
  "use strict";

  const HOST_ID = window.FormRewindFields.UI_HOST_ID;
  const TOAST_MS = 6000;

  const STYLE = `
    :host { all: initial; }
    .stack {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      display: flex; flex-direction: column; gap: 8px; align-items: flex-end;
      font: 13px/1.5 system-ui, -apple-system, "Hiragino Sans", sans-serif;
      --bg: #ffffff; --fg: #202124; --line: #dadce0; --accent: #1a73e8;
    }
    @media (prefers-color-scheme: dark) {
      .stack { --bg: #2d2e31; --fg: #e8eaed; --line: #5f6368; --accent: #8ab4f8; }
    }
    .card {
      box-sizing: border-box; max-width: min(360px, calc(100vw - 32px));
      background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 10px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, .18); padding: 12px 14px;
    }
    .row { display: flex; gap: 8px; align-items: center; justify-content: flex-end; }
    .toast { display: flex; gap: 12px; align-items: center; }
    button {
      font: inherit; cursor: pointer; border-radius: 6px; padding: 4px 12px;
      border: 1px solid var(--line); background: transparent; color: var(--fg);
    }
    button.link { border: none; padding: 4px 6px; color: var(--accent); font-weight: 600; }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  `;

  let stack = null;

  function ensureStack() {
    if (stack && stack.isConnected) return stack;
    const host = document.createElement("div");
    host.id = HOST_ID;
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    stack = document.createElement("div");
    stack.className = "stack";
    root.append(style, stack);
    document.documentElement.append(host);
    return stack;
  }

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...children);
    return node;
  }

  function showToast(text, { onUndo } = {}) {
    const parent = ensureStack();
    parent.querySelector(".toast")?.remove();
    const toast = el("div", { className: "card toast", role: "status" }, [el("span", { textContent: text })]);
    if (onUndo) {
      toast.append(
        el("div", { className: "row" }, [
          el("button", {
            className: "link",
            textContent: "元に戻す",
            onclick: () => {
              toast.remove();
              onUndo();
            },
          }),
        ])
      );
    }
    parent.append(toast);
    setTimeout(() => toast.remove(), onUndo ? TOAST_MS * 2 : TOAST_MS);
  }

  window.FormRewindUI = { showToast };
})();
