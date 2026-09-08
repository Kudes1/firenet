import { useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { api } from "../api/client";
import { useMe } from "../api/queries";
import type { UserResponse } from "../api/types";
import { storageKeys } from "../lib/storage";
import { initialTheme, applyTheme } from "./theme";
import { CollapseIcon, MoonIcon, SunIcon } from "./icons";

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

const navClass = ({ isActive }: { isActive: boolean }) => (isActive ? "active" : undefined);

const setNavGroupOpen = (id: string, open: boolean) => {
  if (open) localStorage.removeItem(storageKeys.navGroup(id));
  else localStorage.setItem(storageKeys.navGroup(id), "closed");
};

export default function Sidebar() {
  const { data: me } = useMe();
  const [theme, setTheme] = useState(initialTheme);
  const [collapsed, setCollapsed] = useState(localStorage.getItem(storageKeys.sidebar) === "collapsed");

  const toggleSidebar = () => {
    const next = !collapsed;
    setCollapsed(next);
    if (next) localStorage.setItem(storageKeys.sidebar, "collapsed");
    else localStorage.removeItem(storageKeys.sidebar);
  };

  return (
    <aside className={`sidebar${collapsed ? " collapsed" : ""}`} data-testid="sidebar">
      <button
        type="button"
        className="sidebar-toggle"
        onClick={toggleSidebar}
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Развернуть меню" : "Свернуть меню"}
      >
        <CollapseIcon />
      </button>
      {NAV_GROUPS.map((group) => (
        <NavGroup key={group.id} group={group} />
      ))}
      <nav className="side-nav">
        {STANDALONE.filter((l) => !l.adminOnly || isAdmin(me)).map((link) => (
          <NavLink key={link.id} to={link.href} end className={navClass} data-testid={`nav-${link.id}`}>
            <span className="label">{link.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="user-box">
        <span className="user-name">{me?.username ?? ""}</span>
        <button
          type="button"
          className="theme-toggle"
          onClick={() => { const next = theme === "dark" ? "light" : "dark"; setTheme(next); applyTheme(next); }}
          aria-label="Сменить тему"
        >
          <span className="icon-sun"><SunIcon /></span>
          <span className="icon-moon"><MoonIcon /></span>
        </button>
        {/* Полная перезагрузка — осознанно: logout должен гарантированно
            сбросить всё состояние (react-query, модули, storage), navigate()
            этого не даёт. */}
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

function NavGroup({ group }: { group: (typeof NAV_GROUPS)[number] }) {
  const { pathname } = useLocation();
  const isActive = group.links.some((l) => pathname.startsWith(l.href));
  // Группы по умолчанию раскрыты — иначе в свежем браузере без localStorage
  // пользователь не видит ни одной ссылки (закрытой становится только та,
  // что явно свернули: «closed» в ui.nav.<id>).
  const [open, setOpen] = useState(isActive || localStorage.getItem(storageKeys.navGroup(group.id)) !== "closed");
  return (
    <div className={`nav-group${open ? "" : " closed"}`}>
      <button
        type="button"
        className="nav-group-header"
        onClick={() => { setNavGroupOpen(group.id, !open); setOpen(!open); }}
      >
        {group.title}
      </button>
      {open && (
        <nav className="side-nav nav-group-links">
          {group.links.map((link) => (
            <NavLink key={link.id} to={link.href} end className={navClass} data-testid={`nav-${link.id}`}>
              <span className="label">{link.label}</span>
            </NavLink>
          ))}
        </nav>
      )}
    </div>
  );
}

const isAdmin = (me: UserResponse | undefined) => me?.role === "admin";
