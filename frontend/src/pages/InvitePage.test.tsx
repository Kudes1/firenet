import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import InvitePage from "./InvitePage";

function renderInvite() {
  return render(
    <MemoryRouter initialEntries={["/invite/tok123"]}>
      <Routes><Route path="/invite/:token" element={<InvitePage />} /></Routes>
    </MemoryRouter>,
  );
}

describe("InvitePage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the invited username", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ username: "bob" }), { status: 200 })));
    renderInvite();
    expect(await screen.findByText(/bob/)).toBeInTheDocument();
  });

  it("reports an expired invite with its 410 state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "invite expired" }), { status: 410 })));
    renderInvite();
    expect(await screen.findByText("invite expired")).toBeInTheDocument();
  });

  it("submits the password and confirms success", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ username: "bob" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    renderInvite();
    await screen.findByText(/bob/);
    await userEvent.type(screen.getByLabelText("Пароль"), "longpassword1");
    await userEvent.type(screen.getByLabelText("Повторите пароль"), "longpassword1");
    await userEvent.click(screen.getByRole("button", { name: "Активировать" }));
    expect(await screen.findByText(/Пароль задан/)).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe("/api/invites/tok123");
    expect(JSON.parse(init.body as string)).toEqual({ password: "longpassword1", confirmPassword: "longpassword1" });
  });

  it("rejects a mismatch without sending it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ username: "bob" }), { status: 200 })));
    renderInvite();
    await screen.findByText(/bob/);
    await userEvent.type(screen.getByLabelText("Пароль"), "longpassword1");
    await userEvent.type(screen.getByLabelText("Повторите пароль"), "other-password");
    await userEvent.click(screen.getByRole("button", { name: "Активировать" }));
    expect(await screen.findByText("Пароли не совпадают")).toBeInTheDocument();
  });
});
