// 設定の既定値。content script・service worker・ポップアップ・設定画面のどこからも読めるよう、
// モジュールにせず globalThis に置く。
globalThis.FORM_REWIND_DEFAULTS = Object.freeze({
  autoload: true, // 「すべてのフィールドを保存」した値を、ページを開いたときに空欄へ入れる
});

globalThis.FORM_REWIND_SETTINGS_KEY = "settings";
