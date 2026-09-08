import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { server } from "../test/msw";
import { renderPage } from "../test/renderPage";
import * as fx from "../api/fixtures";
import UsersPage from "./UsersPage";

beforeAll(() => server.listen());
afterEach(() => { server.resetHandlers(); sessionStorage.clear(); });
afterAll(() => server.close());

const USERS = [
  fx.userFixture,
  { id: "u2", username: "bob", role: "user", activated: false, createdAt: "2026-09-02T10:00:00Z" },
];

describe("UsersPage", () => {
  it("shows the access banner for non-admins", async () => {
    server.use(
      http.get("/api/users", () => HttpResponse.json({ error: "admin role required" }, { status: 403 })),
      http.get("/api/me", () => HttpResponse.json({ ...fx.userFixture, id: "u9", role: "user" })),
    );
    renderPage(<UsersPage />, "/ui/users");
    expect(await screen.findByText(/Доступ только для администраторов/)).toBeInTheDocument();
  });

  it("lists users with role and activation state", async () => {
    server.use(
      http.get("/api/users", () => HttpResponse.json(USERS)),
      http.get("/api/me", () => HttpResponse.json(fx.userFixture)),
    );
    renderPage(<UsersPage />, "/ui/users");
    expect(await screen.findByText("bob")).toBeInTheDocument();
    expect(screen.getByText("Ожидает")).toBeInTheDocument();
    expect(screen.getByText("Активен")).toBeInTheDocument();
  });

  it("creates a user and shows the invite link", async () => {
    server.use(
      http.get("/api/users", () => HttpResponse.json([])),
      http.get("/api/me", () => HttpResponse.json(fx.userFixture)),
      http.post("/api/users", () => HttpResponse.json(
        { user: fx.userFixture, inviteUrl: "http://host/invite/tok" }, { status: 201 })),
    );
    const { user } = renderPage(<UsersPage />, "/ui/users");
    await user.click(await screen.findByTitle("Добавить пользователя"));
    await user.type(await screen.findByLabelText("Логин"), "newbie");
    await user.click(screen.getByRole("button", { name: "Создать" }));
    // URL живёт в <input readOnly value=...>, а не в тексте — текстовый
    // findByText его не видит.
    expect(await screen.findByDisplayValue("http://host/invite/tok")).toBeInTheDocument();
  });

  it("hides edit and delete for the current user", async () => {
    server.use(
      http.get("/api/users", () => HttpResponse.json(USERS)),
      http.get("/api/me", () => HttpResponse.json(fx.userFixture)),
    );
    renderPage(<UsersPage />, "/ui/users");
    await screen.findByText("bob");
    expect(screen.queryByTitle("Удалить пользователя admin")).toBeNull();
    expect(screen.getByTitle("Удалить пользователя bob")).toBeInTheDocument();
  });

  it("copies the invite link to the clipboard", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    server.use(
      http.get("/api/users", () => HttpResponse.json(USERS)),
      http.get("/api/me", () => HttpResponse.json(fx.userFixture)),
      http.post("/api/users/u2/invite", () => HttpResponse.json({ inviteUrl: "http://host/invite/tok2" })),
    );
    // Спай ставится ПОСЛЕ renderPage: userEvent.setup() внутри renderPage
    // подменяет navigator.clipboard своим стабом и затёр бы более ранний spy.
    // navigator.clipboard — только геттер, Object.assign не работает.
    const { user } = renderPage(<UsersPage />, "/ui/users");
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await screen.findByText("bob");
    await user.click(screen.getByTitle("Показать ссылку для bob"));
    await user.click(await screen.findByRole("button", { name: "Копировать" }));
    expect(writeText).toHaveBeenCalledWith("http://host/invite/tok2");
  });
});
