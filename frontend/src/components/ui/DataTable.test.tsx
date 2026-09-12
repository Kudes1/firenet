import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
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
});
