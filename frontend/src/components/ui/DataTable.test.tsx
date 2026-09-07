import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import DataTable, { type Column } from "./DataTable";

type Row = { name: string; cidr: string };

const columns: Column<Row>[] = [
  { key: "name", title: "Имя", render: (r) => r.name, filter: (r, q) => r.name.toLowerCase().includes(q.toLowerCase()) },
  { key: "cidr", title: "CIDR", render: (r) => r.cidr },
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
    await userEvent.click(screen.getByTitle("Поиск"));
    await userEvent.type(screen.getByPlaceholderText("Имя"), "dm");
    expect(screen.queryByText("lan")).toBeNull();
    expect(screen.getByText("dmz")).toBeInTheDocument();
  });

  it("shows the empty state for no matches", async () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.name} />);
    await userEvent.click(screen.getByTitle("Поиск"));
    await userEvent.type(screen.getByPlaceholderText("Имя"), "zzz");
    expect(screen.getByText("Ничего не найдено")).toBeInTheDocument();
  });

  it("shows a custom empty state when there is no data at all", () => {
    render(<DataTable columns={columns} rows={[]} rowKey={(r) => r.name} empty="Подсетей нет" />);
    expect(screen.getByText("Подсетей нет")).toBeInTheDocument();
  });
});
