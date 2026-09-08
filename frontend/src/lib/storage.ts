// Все ключи web-storage приложения в одном месте — e2e-хелпер
// (e2e/helpers/ui.js) пишет draft-ключи literal-строками, не переименовывать вразнобой.
export const storageKeys = {
  sidebar: "ui.sidebar", // "collapsed" | absent
  navGroup: (id: string) => `ui.nav.${id}`, // "closed" | absent (раскрыта)
  theme: "ui.theme", // "light" | "dark"
  draftId: "ui.draft.id", // sessionStorage — активный драфт таба
  lastDraftId: "ui.draft.lastId", // localStorage — последний драфт для нового таба
  draftReadonly: "ui.draft.readonly", // sessionStorage — таб сознательно на текущей версии
} as const;
