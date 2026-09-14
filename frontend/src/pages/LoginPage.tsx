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
    <main className="login-page" data-testid="page-login">
      <form id="login-form" className="login-card" onSubmit={submit} data-testid="login-form">
        <div className="login-visual" aria-hidden="true">
          <div className="login-network">
            <span className="login-network-line login-network-line--one" />
            <span className="login-network-line login-network-line--two" />
            <span className="login-network-line login-network-line--three" />
            <span className="login-network-node login-network-node--one" />
            <span className="login-network-node login-network-node--two" />
            <span className="login-network-node login-network-node--three" />
            <span className="login-network-node login-network-node--four" />
          </div>
          <div className="login-visual-copy">
            <span className="login-visual-kicker">Network workspace</span>
            <h2>Сеть под<br />контролем.</h2>
            <p>Проектируйте топологию спокойно и держите инфраструктуру в фокусе.</p>
          </div>
        </div>

        <div className="login-content">
          <div className="login-brand" aria-label="firenet">
            <span className="login-brand-mark">
              <span />
              <span />
              <span />
            </span>
            <span>firenet</span>
          </div>

          <div className="login-heading">
            <p className="login-kicker">Добро пожаловать</p>
            <h1>С возвращением</h1>
            <p>Войдите, чтобы продолжить работу с вашей сетью.</p>
          </div>

          {activated && <p className="login-message login-message--success" data-testid="login-notice">Пароль задан. Можно войти.</p>}

          <div className="login-fields">
            <label className="login-field">
              <span>Логин</span>
              <input name="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
            </label>
            <label className="login-field">
              <span>Пароль</span>
              <input name="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </label>
          </div>

          {error && <p className="login-message login-message--error" data-testid="login-error" role="alert">{error}</p>}

          <div className="login-actions">
            <button type="submit" className="primary login-submit" disabled={busy || !username || !password}>
              <span>{busy ? "Входим…" : "Войти"}</span>
              <span className="login-submit-icon" aria-hidden="true">→</span>
            </button>
          </div>
        </div>
      </form>
      <p className="login-footer">firenet · topology control</p>
    </main>
  );
}
