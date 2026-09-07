import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ApiError, api } from "../api/client";
import type { UserResponse } from "../api/types";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const [params] = useSearchParams();

  // next из ?next= — единственный источник цели после логина. Путь вида
  // //host отбрасывается, иначе это открытый редирект.
  const nextParam = params.get("next") ?? "";
  const target = nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/ui/topology";
  // activated=1 — notice после успешной активации через инвайт (легаси login.js).
  const activated = params.get("activated") === "1";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      // Клиент (Task 4) не редиректит 401 на /login — мы уже здесь, поэтому
      // ошибка приходит как ApiError с message бэкенда и попадает в catch.
      await api.post<UserResponse>("/api/login", { username, password });
      navigate(target, { replace: true });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Не удалось войти");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page" data-testid="page-login">
      <form id="login-form" className="modal-grid" onSubmit={submit} data-testid="login-form">
        <h1>firenet</h1>
        {activated && <p className="cell-hint" data-testid="login-notice">Пароль задан. Можно войти.</p>}
        <label>
          Логин
          <input name="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        </label>
        <label>
          Пароль
          <input name="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>
        {error && <p className="cell-hint" data-testid="login-error">{error}</p>}
        <div className="modal-actions">
          <button type="submit" className="primary" disabled={busy || !username || !password}>Войти</button>
        </div>
      </form>
    </main>
  );
}
