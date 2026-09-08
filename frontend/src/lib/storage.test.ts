import { describe, expect, it } from "vitest";
import { storageKeys } from "./storage";

// Контракт с e2e/helpers/ui.js: он пишет draft-ключи literal-строками.
describe("storageKeys", () => {
  it("uses the ui.* namespace", () => {
    expect(storageKeys.sidebar).toBe("ui.sidebar");
    expect(storageKeys.navGroup("firewall")).toBe("ui.nav.firewall");
    expect(storageKeys.theme).toBe("ui.theme");
    expect(storageKeys.draftId).toBe("ui.draft.id");
    expect(storageKeys.lastDraftId).toBe("ui.draft.lastId");
    expect(storageKeys.draftReadonly).toBe("ui.draft.readonly");
  });
});
