import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { resetRevision } from "../api/revision";

// Ключи совпадают с common.js: e2e-хелпер openWithDraft пишет их напрямую
// через addInitScript, поэтому менять их нельзя.
const DRAFT_ID_KEY = "firenet-draft-id";
const LAST_DRAFT_ID_KEY = "firenet-last-draft-id";
const READONLY_KEY = "firenet-draft-readonly";

// Активный драфт живёт в sessionStorage (у каждого таба свой), последний —
// в localStorage, чтобы новый таб продолжил в нём же. READONLY_KEY —
// «этот таб сознательно вернулся к текущей версии», иначе sessionStorage
// пуст и мы бы снова подхватили последний драфт.
function readInitialDraft(): string | null {
  const active = sessionStorage.getItem(DRAFT_ID_KEY);
  if (active) return active;
  if (sessionStorage.getItem(READONLY_KEY)) return null;
  const last = localStorage.getItem(LAST_DRAFT_ID_KEY);
  if (last) sessionStorage.setItem(DRAFT_ID_KEY, last);
  return last || null;
}

type DraftContextValue = {
  draftId: string | null;
  setDraftId: (id: string | null) => void;
  isReadOnly: boolean;
  scope: string;
  apiPath: (suffix: string) => string;
};

const Ctx = createContext<DraftContextValue | null>(null);

export function DraftProvider({ children }: { children: ReactNode }) {
  const [draftId, setDraftIdState] = useState<string | null>(readInitialDraft);

  const setDraftId = useCallback((id: string | null) => {
    const previous = draftId; // активный драфт на момент вызова
    resetRevision(); // ревизия принадлежит драфту, к другому она не относится
    if (id) {
      sessionStorage.setItem(DRAFT_ID_KEY, id);
      sessionStorage.removeItem(READONLY_KEY);
      localStorage.setItem(LAST_DRAFT_ID_KEY, id);
    } else {
      sessionStorage.removeItem(DRAFT_ID_KEY);
      sessionStorage.setItem(READONLY_KEY, "1");
      if (localStorage.getItem(LAST_DRAFT_ID_KEY) === previous) {
        localStorage.removeItem(LAST_DRAFT_ID_KEY);
      }
    }
    setDraftIdState(id);
  }, [draftId]);

  const value = useMemo<DraftContextValue>(() => {
    const scope = draftId ? `draft:${draftId}` : "current";
    return {
      draftId,
      setDraftId,
      isReadOnly: !draftId,
      scope,
      apiPath: (suffix: string) =>
        draftId ? `/api/drafts/${draftId}/${suffix}` : `/api/versions/current/${suffix}`,
    };
  }, [draftId, setDraftId]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDraft(): DraftContextValue {
  const value = useContext(Ctx);
  if (!value) throw new Error("useDraft must be used inside <DraftProvider>");
  return value;
}
