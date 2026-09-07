// CAS-токен драфта: бэкенд выдаёт X-Draft-Revision на каждом чтении и
// сверяет его на каждой записи (409 при расхождении). Модульный стор
// повторяет роль lastDraftRevision из common.js: клиент пишет токен из
// любого ответа и шлёт его со следующей мутацией, вызывающие код об этом
// не думает.
let revision: string | null = null;

export const getRevision = (): string | null => revision;

export function setRevision(value: string | null): void {
  revision = value;
}

export const resetRevision = (): void => {
  revision = null;
};

export function revisionHeaders(): Record<string, string> {
  return revision ? { "X-Draft-Revision": revision } : {};
}
