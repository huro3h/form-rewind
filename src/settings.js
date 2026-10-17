// 設定の既定値。content script・service worker・ポップアップ・設定画面のどこからも読めるよう、
// モジュールにせず globalThis に置く。
globalThis.FORM_REWIND_DEFAULTS = Object.freeze({
  maxPerPage: 20, // 1ページあたりに残す履歴の件数(固定した履歴は数えない)
  retentionDays: 30, // 履歴を残す日数(固定した履歴は消さない)
  showToast: true, // ページごとに最初の保存で「自動で保存しています」を出す
  autoload: true, // 「すべてのフィールドを保存」した値を、ページを開いたときに空欄へ入れる
  pausedDomains: [], // 自動保存を止めているドメイン
});

globalThis.FORM_REWIND_SETTINGS_KEY = "settings";
