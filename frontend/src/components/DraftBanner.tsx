import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useVersions } from "../api/queries";
import type { DraftResponse } from "../api/types";
import { useDraft } from "../draft/DraftContext";

// Плашка контекста: что сейчас редактируется и как из этого выйти. Если
// активный драфт исчез (удалён или подтверждён в другом табе) — таб
// возвращается к текущей версии, как это делал renderDraftBanner.
// Расхождение с легаси: легаси при «исчезнувшем» драфте перезагружал
// страницу (window.location.reload()); здесь таб просто переключается на
// текущую версию без перезагрузки — в реактивной модели это то же самое.
export default function DraftBanner() {
  const { draftId, setDraftId } = useDraft();
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

  if (!draftId) return <ReadonlyBanner />;

  return (
    <div className="draft-banner draft-banner-editing" data-testid="draft-banner">
      <span>Черновик «{name}».</span>
      <button type="button" onClick={exit}>Вернуться к текущей версии</button>
    </div>
  );
}

// В read-only режиме баннер информационный: создать черновик можно на
// странице «Черновики», здесь только показываем текущую версию.
function ReadonlyBanner() {
  const { data: versions } = useVersions(1);
  const version = versions?.[0];
  return (
    <div className="draft-banner draft-banner-readonly" data-testid="draft-banner">
      <span>Только чтение — версия {version ? version.id : "—"}.</span>
    </div>
  );
}
