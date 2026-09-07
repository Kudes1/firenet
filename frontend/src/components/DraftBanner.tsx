import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useCreateDraft, useVersions } from "../api/queries";
import type { DraftResponse } from "../api/types";
import { useDraft } from "../draft/DraftContext";
import { notify } from "./notify";

// Плашка контекста: что сейчас редактируется и как из этого выйти. Если
// активный драфт исчез (удалён или подтверждён в другом табе) — таб
// возвращается к текущей версии, как это делал renderDraftBanner.
// Расхождение с легаси: легаси при «исчезнувшем» драфте перезагружал
// страницу (window.location.reload()); здесь таб просто переключается на
// текущую версию без перезагрузки — в реактивной модели это то же самое.
export default function DraftBanner() {
  const { draftId, setDraftId } = useDraft();
  const createDraft = useCreateDraft();
  const [name, setName] = useState("");
  const exit = () => setDraftId(null);

  useEffect(() => {
    if (!draftId) return;
    let cancelled = false;
    void api
      .get<DraftResponse>(`/api/drafts/${draftId}`)
      .then((draft) => {
        if (cancelled) return;
        if (draft.status === "merged") exit();
        else setName(draft.name);
      })
      .catch(() => { if (!cancelled) exit(); });
    return () => { cancelled = true; };
  }, [draftId]);

  if (!draftId) return <ReadonlyBanner onCreate={createDraft} />;

  return (
    <div className="draft-banner draft-banner-editing" data-testid="draft-banner">
      <span>Черновик «{name}».</span>
      <button type="button" onClick={exit}>Вернуться к текущей версии</button>
    </div>
  );
}

// Имя черновика — отдельный input, а не window.prompt: легаси использовал
// Alpine-хелпер prompt, которого в React-приложении нет (и в стандартных
// браузерах window.prompt не существует).
function ReadonlyBanner({ onCreate }: { onCreate: ReturnType<typeof useCreateDraft> }) {
  const { data: versions } = useVersions(1);
  const version = versions?.[0];
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const draft = await onCreate.mutateAsync(name);
      sessionStorage.setItem("firenet-draft-id", draft.id);
      localStorage.setItem("firenet-last-draft-id", draft.id);
      window.location.reload();
    } catch (error) {
      notify(`Не удалось создать черновик: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="draft-banner draft-banner-readonly" data-testid="draft-banner">
      <span>Только чтение — версия {version ? version.id : "—"}.</span>
      <label>
        Имя черновика
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <button type="button" onClick={() => void submit()} disabled={!name.trim() || busy}>
        Открыть черновик
      </button>
    </div>
  );
}
