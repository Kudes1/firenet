import { useState } from "react";
import { NavLink } from "react-router-dom";
import { api } from "../api/client";
import { useMe } from "../api/queries";
import type { UserResponse } from "../api/types";
import { initialTheme, applyTheme } from "./theme";
import { CollapseIcon, MoonIcon, SunIcon } from "./icons";

// Группы 1:1 с NAV_GROUPS из common.js; состояние раскрытия — в localStorage
// под теми же ключами firenet-nav-<id>.
const NAV_GROUPS = [
  { id: "topology", title: "Топология", links: [
    { id: "topology", href: "/ui/topology", label: "Схема" },
    { id: "devices", href: "/ui/devices", label: "Устройства" },
    { id: "networks", href: "/ui/networks", label: "Сети" },
    { id: "unions", href: "/ui/unions", label: "Объединения" },
    { id: "links", href: "/ui/links", label: "Связи" },
  ] },
  { id: "firewall", title: "Firewall", links: [
    { id: "subnets", href: "/ui/subnets", label: "Подсети" },
    { id: "sets", href: "/ui/sets", label: "Наборы" },
    { id: "rules", href: "/ui/rules", label: "Правила" },
    { id: "compile", href: "/ui/compile", label: "Компиляция" },
  ] },
  { id: "versions", title: "Версии", links: [
    { id: "drafts", href: "/ui/drafts", label: "Черновики" },
    { id: "history", href: "/ui/history", label: "История" },
  ] },
];

const STANDALONE = [
  { id: "search", href: "/ui/search", label: "Поиск" },
  { id: "diagnose", href: "/ui/diagnose", label: "Диагностика" },
  { id: "users", href: "/ui/users", label: "Пользователи", adminOnly: true },
];

export default function Sidebar({ active }: { active: string }) {
  const { data: me } = useMe();
  const [theme, setTheme] = useState(initialTheme);
  const [collapsed, setCollapsed] = useState(localStorage.getItem("firenet-sidebar") === "collapsed");

  const toggleGroup = (id: string, open: boolean) => {
    localStorage.setItem("firenet-nav-" + id, open ? "open" : "closed");
  };

  const toggleSidebar = () => {
    const next = !collapsed;
    setCollapsed(next);
    // «open» — ровно как легаси (common.js): развёрнутое состояние пишется
    // этим значением, чтобы ключ firenet-sidebar остался 1:1.
    localStorage.setItem("firenet-sidebar", next ? "collapsed" : "open");
  };

  return (
    <aside className={`sidebar${collapsed ? " collapsed" : ""}`} data-testid="sidebar">
      <button type="button" className="sidebar-toggle" onClick={toggleSidebar} aria-label="Свернуть меню">
        <CollapseIcon />
      </button>
      {NAV_GROUPS.map((group) => (
        <NavGroup key={group.id} group={group} active={active} onToggle={toggleGroup} />
      ))}
      <nav className="side-nav">
        {STANDALONE.filter((l) => !l.adminOnly || isAdmin(me)).map((link) => (
          <NavLink key={link.id} to={link.href} data-testid={`nav-${link.id}`}>
            <span className="label">{link.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="user-box">
        <span className="user-name">{me?.username ?? ""}</span>
        <button
          type="button"
          id="theme-toggle"
          className="theme-toggle"
          onClick={() => { const next = theme === "dark" ? "light" : "dark"; setTheme(next); applyTheme(next); }}
          aria-label="Сменить тему"
        >
          <span className="icon-sun"><SunIcon /></span>
          <span className="icon-moon"><MoonIcon /></span>
        </button>
        <button
          type="button"
          className="logout-btn"
          onClick={() => { void api.post("/api/logout").then(() => { window.location.href = "/login"; }); }}
        >
          Выйти
        </button>
      </div>
    </aside>
  );
}

function NavGroup({ group, active, onToggle }: {
  group: (typeof NAV_GROUPS)[number];
  active: string;
  onToggle: (id: string, open: boolean) => void;
}) {
  const isActive = group.links.some((l) => l.id === active);
  // Группы по умолчанию раскрыты — иначе в свежем браузере без localStorage
  // пользователь не видит ни одной ссылки (закрытой становится только та,
  // что явно свернули: «closed» в firenet-nav-<id>).
  const [open, setOpen] = useState(isActive || localStorage.getItem("firenet-nav-" + group.id) !== "closed");
  return (
    <div className={`nav-group${open ? "" : " closed"}`}>
      <button
        type="button"
        className="nav-group-header"
        onClick={() => { onToggle(group.id, !open); setOpen(!open); }}
      >
        {group.title}
      </button>
      {open && (
        <nav className="side-nav nav-group-links">
          {group.links.map((link) => (
            <NavLink
              key={link.id}
              to={link.href}
              className={link.id === active ? "active" : undefined}
              data-testid={`nav-${link.id}`}
            >
              <span className="label">{link.label}</span>
            </NavLink>
          ))}
        </nav>
      )}
    </div>
  );
}

const isAdmin = (me: UserResponse | undefined) => me?.role === "admin";
