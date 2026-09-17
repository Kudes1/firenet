import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ApiError, api } from "../api/client";
import type { InviteInfoResponse } from "../api/types";

export default function InvitePage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.get<InviteInfoResponse>(`/api/invites/${token}`)
      .then((info) => { if (!cancelled) setUsername(info.username); })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : "Ссылка недоступна");
      });
    return () => { cancelled = true; };
  }, [token]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("Пароли не совпадают");
      return;
    }
    try {
      await api.post<void>(`/api/invites/${token}`, { password, confirmPassword: confirm });
      setDone(true);
      // ?activated=1 — как в легаси invite.js: login.js показывает по нему notice.
      setTimeout(() => navigate("/login?activated=1", { replace: true }), 2000);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Не удалось задать пароль");
    }
  };

  return (
    <main className="login-page" data-testid="page-invite">
      <form className="login-card login-card--single" onSubmit={submit} data-testid="invite-form">
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
            <p className="login-kicker">Активация аккаунта</p>
            <h1>{username || "Активация"}</h1>
            {!done && <p>Задайте пароль, чтобы начать работу.</p>}
          </div>

          {done ? (
            <p className="login-message login-message--success" data-testid="invite-done">Пароль задан. Можно войти.</p>
          ) : (
            <>
              <div className="login-fields">
                <label className="login-field">
                  <span>Пароль</span>
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
                </label>
                <label className="login-field">
                  <span>Повторите пароль</span>
                  <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
                </label>
              </div>

              {error && <p className="login-message login-message--error" data-testid="invite-error" role="alert">{error}</p>}

              <div className="login-actions">
                <button type="submit" className="primary login-submit" disabled={!password || !confirm}>
                  <span>Активировать</span>
                  <span className="login-submit-icon" aria-hidden="true">→</span>
                </button>
              </div>
            </>
          )}
        </div>
      </form>
      <p className="login-footer">firenet · topology control</p>
    </main>
  );
}
