import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LoginPage from "./LoginPage";

const navigate = vi.fn();
vi.mock("react-router-dom", async (orig) => ({
  ...(await orig<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}));

describe("LoginPage", () => {
  beforeEach(() => {
    sessionStorage.clear();
    delete (window as { location?: unknown }).location;
    // Отступление от брифа: pathname обязателен — клиент (Task 4) решает,
    // редиректить ли 401, по window.location.pathname; без него 401 повиснет
    // в redirectToLogin вместо того, чтобы бросить ловимый ApiError.
    (window as { location?: unknown }).location = { href: "", pathname: "/login", search: "?next=%2Fui%2Frules" };
  });
  afterEach(() => vi.unstubAllGlobals());

  it("renders a dedicated welcome shell", () => {
    render(<MemoryRouter><LoginPage /></MemoryRouter>);

    expect(screen.getByTestId("page-login")).toHaveClass("login-page");
    expect(screen.getByRole("heading", { name: "С возвращением" })).toBeInTheDocument();
  });

  it("posts credentials and follows ?next on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "1", username: "admin", role: "admin", activated: true, createdAt: "",
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    // useSearchParams читает ?next из router-контекста (MemoryRouter), а не из
    // window.location, поэтому initialEntries — единственный способ задать next.
    render(<MemoryRouter initialEntries={["/login?next=%2Fui%2Frules"]}><LoginPage /></MemoryRouter>);

    await userEvent.type(screen.getByLabelText("Логин"), "admin");
    await userEvent.type(screen.getByLabelText("Пароль"), "secret");
    await userEvent.click(screen.getByRole("button", { name: "Войти" }));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/login");
    expect(JSON.parse(init.body as string)).toEqual({ username: "admin", password: "secret" });
    // Отступление от брифа: navigate вызывается как (target, { replace: true }),
    // поэтому проверяем оба аргумента.
    expect(navigate).toHaveBeenCalledWith("/ui/rules", { replace: true });
  });

  it("shows the server error on bad credentials", async () => {
    // 401 от /api/login — это неверные креды, а не потеря сессии: клиент
    // (Task 4) не редиректит, а бросает ApiError с message бэкенда, который
    // LoginPage показывает в #login-error.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid username or password" }), { status: 401 })));
    render(<MemoryRouter><LoginPage /></MemoryRouter>);
    // Отступление от брифа: кнопка disabled при пустых полях, поэтому креды
    // нужно заполнить, чтобы сабмит вообще прошёл.
    await userEvent.type(screen.getByLabelText("Логин"), "admin");
    await userEvent.type(screen.getByLabelText("Пароль"), "secret");
    await userEvent.click(screen.getByRole("button", { name: "Войти" }));
    expect(await screen.findByText("invalid username or password")).toBeInTheDocument();
  });
});
