import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DraftProvider, useDraft } from "./DraftContext";

function Probe() {
  const { draftId, isReadOnly, apiPath, setDraftId } = useDraft();
  return (
    <div>
      <span data-testid="draftId">{draftId ?? "-"}</span>
      <span data-testid="readOnly">{String(isReadOnly)}</span>
      <span data-testid="path">{apiPath("topology")}</span>
      <button onClick={() => setDraftId("d9")}>set</button>
      <button onClick={() => setDraftId(null)}>clear</button>
    </div>
  );
}

describe("DraftProvider", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });
  afterEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it("starts read-only and routes to the current version", () => {
    render(<DraftProvider><Probe /></DraftProvider>);
    expect(screen.getByTestId("readOnly").textContent).toBe("true");
    expect(screen.getByTestId("path").textContent).toBe("/api/versions/current/topology");
  });

  it("routes through the draft once set", async () => {
    render(<DraftProvider><Probe /></DraftProvider>);
    await act(async () => { screen.getByText("set").click(); });
    expect(screen.getByTestId("draftId").textContent).toBe("d9");
    expect(screen.getByTestId("path").textContent).toBe("/api/drafts/d9/topology");
    expect(localStorage.getItem("firenet-last-draft-id")).toBe("d9");
  });

  it("keeps read-only explicit for the tab and forgets the last draft", async () => {
    render(<DraftProvider><Probe /></DraftProvider>);
    await act(async () => { screen.getByText("set").click(); });
    await act(async () => { screen.getByText("clear").click(); });
    expect(screen.getByTestId("readOnly").textContent).toBe("true");
    expect(sessionStorage.getItem("firenet-draft-readonly")).toBe("1");
    expect(localStorage.getItem("firenet-last-draft-id")).toBeNull();
  });

  it("restores the last draft from localStorage in a new tab", () => {
    localStorage.setItem("firenet-last-draft-id", "d5");
    render(<DraftProvider><Probe /></DraftProvider>);
    expect(screen.getByTestId("draftId").textContent).toBe("d5");
  });

  it("throws outside the provider", () => {
    expect(() => renderHook(() => useDraft())).toThrow(/DraftProvider/);
  });
});
