import { describe, expect, it, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "./test/msw";
import * as fx from "./api/fixtures";
import App from "./App";

// App теперь рендерит Layout (сайдбар + баннер драфта), которому нужны
// QueryClientProvider и MSW: Sidebar зовёт /api/me, ReadonlyBanner — /api/versions.
beforeAll(() => server.listen());
beforeEach(() => {
  server.use(http.get("/api/versions", () => HttpResponse.json([fx.versionInfoFixture])));
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const pages = [
  ["/ui/topology", "topology"],
  ["/ui/diagnose", "diagnose"],
  ["/ui/unknown", "notfound"],
] as const;

describe("App routing", () => {
  it.each(pages)("renders placeholder for %s", (path, name) => {
    renderAt(path);
    expect(screen.getByTestId(`page-${name}`)).toHaveTextContent(name);
  });

  // Задача 8: /login и /invite/:token больше не заглушки — реальные страницы
  // с теми же data-testid. Задачи 10–14: /ui/subnets, /ui/networks,
  // /ui/devices, /ui/sets, /ui/unions, /ui/links, /ui/rules — реальные страницы.
  // Задача 15: /ui/compile, /ui/search, /ui/history — реальные страницы.
  // Задача 16: /ui/drafts, /ui/users — реальные страницы.
  it.each([
    ["/login", "page-login"],
    ["/invite/abc123", "page-invite"],
  ] as const)("renders the real page at %s", (path, testId) => {
    renderAt(path);
    expect(screen.getByTestId(testId)).toBeInTheDocument();
  });

  it.each(["/ui/compile", "/ui/search", "/ui/history"] as const)("renders the real page at %s", async (path) => {
    renderAt(path);
    expect(await screen.findByTestId(`page-${path.replace("/ui/", "")}`)).toBeInTheDocument();
  });

  it("renders the real subnets page at /ui/subnets", async () => {
    renderAt("/ui/subnets");
    expect(await screen.findByTestId("page-subnets")).toBeInTheDocument();
    expect(await screen.findByText("lan")).toBeInTheDocument();
  });

  it.each(["/ui/networks", "/ui/devices", "/ui/sets", "/ui/unions", "/ui/links", "/ui/rules", "/ui/drafts", "/ui/users"] as const)("renders the real page at %s", async (path) => {
    renderAt(path);
    expect(await screen.findByTestId(`page-${path.replace("/ui/", "")}`)).toBeInTheDocument();
  });

  it("redirects / to topology page", () => {
    renderAt("/");
    expect(screen.getByTestId("page-topology")).toBeInTheDocument();
  });
});
