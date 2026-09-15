import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import DataTable, { type Column } from "./DataTable";

type Row = { name: string; cidr: string };

const columns: Column<Row>[] = [
  { key: "name", title: "Имя", render: (r) => r.name, filter: (r, q) => r.name.toLowerCase().includes(q.toLowerCase()) },
  { key: "cidr", title: "CIDR", render: (r) => r.cidr },
];

const filterableColumns: Column<Row>[] = [
  { key: "name", title: "Имя", render: (r) => r.name, filter: (r, q) => r.name.toLowerCase().includes(q.toLowerCase()) },
  { key: "cidr", title: "CIDR", render: (r) => r.cidr, filter: (r, q) => r.cidr.toLowerCase().includes(q.toLowerCase()) },
  { key: "actions", title: "", render: () => null, filterReset: true },
];

const rows: Row[] = [
  { name: "lan", cidr: "10.0.0.0/24" },
  { name: "dmz", cidr: "192.168.0.0/24" },
];

describe("DataTable", () => {
  afterEach(() => {
    localStorage.removeItem("data-table-widths");
  });

  it("renders rows and column titles", () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.name} />);
    expect(screen.getByText("lan")).toBeInTheDocument();
    expect(screen.getByText("10.0.0.0/24")).toBeInTheDocument();
  });

  it("filters by the searchable column", async () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.name} />);
    await userEvent.click(screen.getByRole("button", { name: "Открыть поиск" }));
    await userEvent.type(screen.getByPlaceholderText("Имя"), "dm");
    expect(screen.queryByText("lan")).toBeNull();
    expect(screen.getByText("dmz")).toBeInTheDocument();
  });

  it("closes search while keeping filters inactive until it is reopened", async () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.name} />);

    const openButton = screen.getByRole("button", { name: "Открыть поиск" });
    expect(openButton).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(openButton);
    await userEvent.type(screen.getByPlaceholderText("Имя"), "dm");
    expect(screen.queryByText("lan")).toBeNull();

    const closeButton = screen.getByRole("button", { name: "Закрыть поиск" });
    const searchRow = screen.getByPlaceholderText("Имя").closest("tr");
    expect(closeButton).toHaveAttribute("aria-expanded", "true");
    expect(closeButton.querySelector(".search-toggle-close")).toBeInTheDocument();
    expect(closeButton.getAttribute("aria-controls")).not.toBeNull();
    expect(closeButton.getAttribute("aria-controls")).toBe(searchRow?.getAttribute("id"));

    await userEvent.click(closeButton);
    expect(screen.queryByPlaceholderText("Имя")).toBeNull();
    expect(screen.getByText("lan")).toBeInTheDocument();
    expect(screen.getByText("dmz")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Открыть поиск" })).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(screen.getByRole("button", { name: "Открыть поиск" }));
    expect(screen.getByPlaceholderText("Имя")).toHaveValue("dm");
    expect(screen.queryByText("lan")).toBeNull();
  });

  it("shows the empty state for no matches", async () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.name} />);
    await userEvent.click(screen.getByRole("button", { name: "Открыть поиск" }));
    await userEvent.type(screen.getByPlaceholderText("Имя"), "zzz");
    expect(screen.getByText("Ничего не найдено")).toBeInTheDocument();
  });

  it("clears all filters and keeps the search row open", async () => {
    render(<DataTable columns={filterableColumns} rows={rows} rowKey={(r) => r.name} />);
    await userEvent.click(screen.getByRole("button", { name: "Открыть поиск" }));
    await userEvent.type(screen.getByPlaceholderText("Имя"), "dm");
    await userEvent.type(screen.getByPlaceholderText("CIDR"), "10");

    expect(screen.getByText("Ничего не найдено")).toBeInTheDocument();

    const reset = screen.getByTitle("Сбросить фильтры");
    const searchRow = reset.closest("tr");
    expect(searchRow).toHaveClass("search-row");
    expect(reset.closest("th")).toBe(searchRow?.lastElementChild);

    await userEvent.click(reset);

    expect(screen.getByPlaceholderText("Имя")).toHaveValue("");
    expect(screen.getByPlaceholderText("CIDR")).toHaveValue("");
    expect(screen.getByText("lan")).toBeInTheDocument();
    expect(screen.getByText("dmz")).toBeInTheDocument();
  });

  it("shows a custom empty state when there is no data at all", () => {
    render(<DataTable columns={columns} rows={[]} rowKey={(r) => r.name} empty="Подсетей нет" />);
    expect(screen.getByText("Подсетей нет")).toBeInTheDocument();
  });

  it("resizes adjacent columns and persists their widths", () => {
    const resizableColumns: Column<Row>[] = [
      { key: "name", title: "Имя", width: "200px", render: (r) => r.name },
      { key: "cidr", title: "CIDR", width: "300px", render: (r) => r.cidr },
    ];
    render(
      <DataTable
        columns={resizableColumns}
        rows={rows}
        rowKey={(r) => r.name}
        resizable
        storageKey="data-table-widths"
      />,
    );

    const headers = screen.getAllByRole("columnheader");
    vi.spyOn(headers[0], "getBoundingClientRect").mockReturnValue({ width: 200 } as DOMRect);
    vi.spyOn(headers[1], "getBoundingClientRect").mockReturnValue({ width: 300 } as DOMRect);

    const separator = screen.getByRole("separator", { name: /Имя.*CIDR/ });
    fireEvent.keyDown(separator, { key: "ArrowRight" });

    const widths = screen.getByRole("table").querySelectorAll("col");
    expect(widths[0]).toHaveStyle({ width: "208px" });
    expect(widths[1]).toHaveStyle({ width: "292px" });
    expect(JSON.parse(localStorage.getItem("data-table-widths") ?? "{}"))
      .toMatchObject({ name: "208px", cidr: "292px" });
  });

  it("resets persisted column widths", async () => {
    localStorage.setItem("data-table-widths", JSON.stringify({ name: 230, cidr: 270 }));
    render(
      <DataTable
        columns={[
          { key: "name", title: "Имя", width: "200px", render: (r) => r.name },
          { key: "cidr", title: "CIDR", width: "300px", render: (r) => r.cidr },
        ]}
        rows={rows}
        rowKey={(r) => r.name}
        resizable
        storageKey="data-table-widths"
      />,
    );

    const reset = screen.getByRole("button", { name: "Сбросить ширины колонок" });
    const icon = reset.querySelector(".column-width-icon");
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveAttribute("viewBox", "0 0 24 24");
    await userEvent.click(reset);

    const widths = screen.getByRole("table").querySelectorAll("col");
    expect(widths[0]).toHaveStyle({ width: "200px" });
    expect(widths[1]).toHaveStyle({ width: "300px" });
    expect(JSON.parse(localStorage.getItem("data-table-widths") ?? "{}"))
      .toEqual({ name: "200px", cidr: "300px" });
  });

  it("keeps percentage defaults when persisting column widths", () => {
    render(
      <DataTable
        columns={[
          { key: "name", title: "Имя", width: "22%", render: (r) => r.name },
          { key: "cidr", title: "CIDR", width: "78%", render: (r) => r.cidr },
        ]}
        rows={rows}
        rowKey={(r) => r.name}
        resizable
        storageKey="data-table-widths"
      />,
    );

    expect(JSON.parse(localStorage.getItem("data-table-widths") ?? "{}"))
      .toEqual({ name: "22%", cidr: "78%" });
  });

  it("cancels an active resize gesture", () => {
    render(
      <DataTable
        columns={[
          { key: "name", title: "Имя", width: "200px", render: (r) => r.name },
          { key: "cidr", title: "CIDR", width: "300px", render: (r) => r.cidr },
        ]}
        rows={rows}
        rowKey={(r) => r.name}
        resizable
      />,
    );
    const separator = screen.getByRole("separator", { name: /Имя.*CIDR/ });

    fireEvent.pointerDown(separator, { pointerId: 1 });
    expect(separator).toHaveClass("active");
    fireEvent.pointerCancel(separator);
    expect(separator).not.toHaveClass("active");
  });

  it("normalizes all column widths to pixels before dragging", () => {
    render(
      <DataTable
        columns={[
          { key: "name", title: "Имя", width: "20%", render: (r) => r.name },
          { key: "cidr", title: "CIDR", width: "30%", render: (r) => r.cidr },
          { key: "actions", title: "Действия", width: "50%", render: () => null },
        ]}
        rows={rows}
        rowKey={(r) => r.name}
        resizable
      />,
    );

    const headers = screen.getAllByRole("columnheader");
    [200, 300, 500].forEach((width, index) => {
      vi.spyOn(headers[index], "getBoundingClientRect").mockReturnValue({ width } as DOMRect);
    });

    const separator = screen.getByRole("separator", { name: /Имя.*CIDR/ });
    fireEvent.pointerDown(separator, { clientX: 200, pointerId: 1 });

    const widths = screen.getByRole("table").querySelectorAll("col");
    expect(widths[0]).toHaveStyle({ width: "200px" });
    expect(widths[1]).toHaveStyle({ width: "300px" });
    expect(widths[2]).toHaveStyle({ width: "500px" });
  });
});
