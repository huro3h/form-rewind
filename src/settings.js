// 設定の既定値。content script・service worker・ポップアップ・設定画面のどこからも読めるよう、
// モジュールにせず globalThis に置く。
globalThis.FORM_REWIND_DEFAULTS = Object.freeze({
  autosave: false, // すべてのサイトで自動保存する。オフのときは enabledDomains のサイトだけ
  maxPerPage: 20, // 1ページあたりに残す履歴の件数(固定した履歴は数えない)
  retentionDays: 30, // 履歴を残す日数(固定した履歴は消さない)
  showToast: true, // ページごとに最初の保存で「自動で保存しています」を出す
  autoload: true, // 「すべてのフィールドを保存」した値を、ページを開いたときに空欄へ入れる
  pausedDomains: [], // 自動保存を止めているドメイン(autosave がオンのとき)
  enabledDomains: [], // 自動保存するドメイン(autosave がオフのとき)
});

// そのドメインで自動保存するか。全体の設定がオンなら一時停止のサイト以外、オフなら選んだサイトだけ。
globalThis.FORM_REWIND_AUTOSAVES = (settings, domain) =>
  settings.autosave ? !settings.pausedDomains.includes(domain) : settings.enabledDomains.includes(domain);

globalThis.FORM_REWIND_SETTINGS_KEY = "settings";
