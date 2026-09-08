import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { resetRevision } from "../api/revision";
import { storageKeys } from "../lib/storage";

// Активный драфт живёт в sessionStorage (у каждого таба свой), последний —
// в localStorage, чтобы новый таб продолжил в нём же. draftReadonly —
// «этот таб сознательно вернулся к текущей версии», иначе sessionStorage
// пуст и мы бы снова подхватили последний драфт.
function readInitialDraft(): string | null {
  const active = sessionStorage.getItem(storageKeys.draftId);
  if (active) return active;
  if (sessionStorage.getItem(storageKeys.draftReadonly)) return null;
  const last = localStorage.getItem(storageKeys.lastDraftId);
  if (last) sessionStorage.setItem(storageKeys.draftId, last);
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
      sessionStorage.setItem(storageKeys.draftId, id);
      sessionStorage.removeItem(storageKeys.draftReadonly);
      localStorage.setItem(storageKeys.lastDraftId, id);
    } else {
      sessionStorage.removeItem(storageKeys.draftId);
      sessionStorage.setItem(storageKeys.draftReadonly, "1");
      if (localStorage.getItem(storageKeys.lastDraftId) === previous) {
        localStorage.removeItem(storageKeys.lastDraftId);
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
