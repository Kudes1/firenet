import { resetRevision, revisionHeaders, setRevision } from "./revision";
import type { ErrorResponse } from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly data: unknown;

  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

// loginRedirectURL повторяет common.js: без открытых редиректов и без
// вложенных /login?next=, если мы уже на странице логина.
export function loginRedirectURL(pathname: string, search: string): string {
  if (pathname === "/login") return pathname + search;
  const target = pathname + search;
  const safe = target.startsWith("/") && !target.startsWith("//");
  return "/login" + (safe ? "?next=" + encodeURIComponent(target) : "");
}

let loginRedirectPending: Promise<never> | null = null;

// Один общий pending-promise: страница грузит несколько ресурсов
// параллельно, и без него каждый 401 начал бы свою навигацию — следующий
// успел бы обернуть уже изменившийся URL ещё одним слоем ?next=.
function redirectToLogin(): Promise<never> {
  if (!loginRedirectPending) {
    window.location.href = loginRedirectURL(window.location.pathname, window.location.search);
    loginRedirectPending = new Promise(() => {});
  }
  return loginRedirectPending;
}

export function resetApiState(): void {
  loginRedirectPending = null;
  resetRevision();
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  if (method !== "GET") {
    Object.assign(init.headers as Record<string, string>, revisionHeaders());
  }

  const res = await fetch(path, init);
  // Как в common.js: ревизию обновляем только когда заголовок пришёл.
  // Ответ без него (не-драфтовый API) не должен стирать токен драфта.
  const rev = res.headers.get("X-Draft-Revision");
  if (rev) setRevision(rev);
  // На /login 401 — это просто неверные креды, а не потеря сессии: редирект
  // на /login при уже открытом /login бессмыслен и вешает промис. Поэтому
  // пропускаем redirectToLogin и даём странице показать ошибку (см. Task 8).
  if (res.status === 401 && window.location.pathname !== "/login") return redirectToLogin();
  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const payload: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = (payload as ErrorResponse | null)?.error ?? res.statusText;
    throw new ApiError(res.status, message, payload);
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};
