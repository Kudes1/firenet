// Глобальные уведомления вместо Alpine-события notify: баннер показывается
// из любого места (мутация, 401, валидация) без проброса колбэков. Стор
// живёт отдельно от компонента, чтобы notify() работал и вне рендера.
export type Notice = { message: string; kind: "error" | "ok" };

let current: Notice | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function notify(message: string, kind: Notice["kind"] = "error"): void {
  current = { message, kind };
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { current = null; emit(); }, 6000);
  emit();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const getNotice = (): Notice | null => current;
