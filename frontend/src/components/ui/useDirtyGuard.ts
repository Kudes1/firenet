import { useEffect, useRef } from "react";

export const DIRTY_MESSAGE = "Есть несохранённые изменения. Покинуть страницу без сохранения?";

// Порт DirtyGuard из common.js: baseline снимается в момент вызова,
// markClean — после успешного сохранения.
export function useDirtyGuard<T>(getData: () => T) {
  const baseline = useRef<string>(JSON.stringify(getData()));

  const isDirty = () => JSON.stringify(getData()) !== baseline.current;
  const markClean = () => { baseline.current = JSON.stringify(getData()); };

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!isDirty()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  return { isDirty, markClean, MESSAGE: DIRTY_MESSAGE };
}
