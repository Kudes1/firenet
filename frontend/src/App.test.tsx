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
  ["/ui/subnets", "subnets"],
  ["/ui/networks", "networks"],
  ["/ui/devices", "devices"],
  ["/ui/sets", "sets"],
  ["/ui/unions", "unions"],
  ["/ui/links", "links"],
  ["/ui/rules", "rules"],
  ["/ui/compile", "compile"],
  ["/ui/diagnose", "diagnose"],
  ["/ui/users", "users"],
  ["/ui/drafts", "drafts"],
  ["/ui/history", "history"],
  ["/ui/search", "search"],
  ["/login", "login"],
  ["/invite/abc123", "invite"],
  ["/ui/unknown", "notfound"],
] as const;

describe("App routing", () => {
  it.each(pages)("renders placeholder for %s", (path, name) => {
    renderAt(path);
    expect(screen.getByTestId(`page-${name}`)).toHaveTextContent(name);
  });

  it("redirects / to topology page", () => {
    renderAt("/");
    expect(screen.getByTestId("page-topology")).toBeInTheDocument();
  });
});
