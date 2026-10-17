// ページ右下に出す復元バナーと通知。ページの CSS と混ざらないよう shadow root に描く。
// open にしているのは E2E から押すため。中身は日時と項目数だけで、ページに読まれて困るものはない。
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
      --bg: #ffffff; --fg: #202124; --sub: #5f6368; --line: #dadce0; --accent: #1a73e8; --accent-fg: #ffffff;
    }
    @media (prefers-color-scheme: dark) {
      .stack { --bg: #2d2e31; --fg: #e8eaed; --sub: #9aa0a6; --line: #5f6368; --accent: #8ab4f8; --accent-fg: #202124; }
    }
    .card {
      box-sizing: border-box; max-width: min(360px, calc(100vw - 32px));
      background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 10px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, .18); padding: 12px 14px;
    }
    .title { font-weight: 600; margin: 0 0 2px; }
    .desc { color: var(--sub); margin: 0; }
    .row { display: flex; gap: 8px; align-items: center; justify-content: flex-end; margin-top: 10px; }
    .toast { display: flex; gap: 12px; align-items: center; }
    .toast .row { margin: 0; }
    button {
      font: inherit; cursor: pointer; border-radius: 6px; padding: 4px 12px;
      border: 1px solid var(--line); background: transparent; color: var(--fg);
    }
    button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); font-weight: 600; }
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

  function showBanner({ when, count, onRestore, onDismiss }) {
    const parent = ensureStack();
    parent.querySelector(".banner")?.remove();
    const close = () => banner.remove();
    const banner = el("div", { className: "card banner", role: "dialog" }, [
      el("p", { className: "title", textContent: "以前の入力内容が保存されています" }),
      el("p", { className: "desc", textContent: `${when} 時点・${count}項目` }),
      el("div", { className: "row" }, [
        el("button", {
          textContent: "閉じる",
          onclick: () => {
            close();
            onDismiss();
          },
        }),
        el("button", {
          className: "primary",
          textContent: "復元する",
          onclick: () => {
            close();
            onRestore();
          },
        }),
      ]),
    ]);
    parent.append(banner);
  }

  function hideBanner() {
    stack?.querySelector(".banner")?.remove();
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

  window.FormRewindUI = { showBanner, hideBanner, showToast };
})();
