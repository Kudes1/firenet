import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "./App";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
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
