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
    <main className="page" data-testid="page-invite">
      <form className="modal-grid" onSubmit={submit}>
        <h1>Активация{username ? `: ${username}` : ""}</h1>
        {done ? (
          <p data-testid="invite-done">Пароль задан. Можно войти.</p>
        ) : (
          <>
            <label>
              Пароль
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label>
              Повторите пароль
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
            <div className="modal-actions">
              <button type="submit" className="primary" disabled={!password || !confirm}>Активировать</button>
            </div>
          </>
        )}
        {error && <p className="cell-hint" data-testid="invite-error">{error}</p>}
      </form>
    </main>
  );
}
