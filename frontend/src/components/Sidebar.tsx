import { useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { api } from "../api/client";
import { useMe } from "../api/queries";
import type { UserResponse } from "../api/types";
import { storageKeys } from "../lib/storage";
import { initialTheme, applyTheme } from "./theme";
import {
  ChevronRightIcon,
  CollapseIcon,
  CompileIcon,
  DevicesIcon,
  DiagnoseIcon,
  DraftsIcon,
  HistoryIcon,
  LinksIcon,
  MoonIcon,
  NetworksIcon,
  RulesIcon,
  SearchIcon,
  SetsIcon,
  SubnetsIcon,
  SunIcon,
  TopologyIcon,
  UnionsIcon,
  UsersIcon,
} from "./icons";

const NAV_GROUPS = [
  { id: "topology", title: "Топология", links: [
    { id: "topology", href: "/ui/topology", label: "Схема", Icon: TopologyIcon },
    { id: "devices", href: "/ui/devices", label: "Устройства", Icon: DevicesIcon },
    { id: "networks", href: "/ui/networks", label: "Сети", Icon: NetworksIcon },
    { id: "unions", href: "/ui/unions", label: "Объединения", Icon: UnionsIcon },
    { id: "links", href: "/ui/links", label: "Связи", Icon: LinksIcon },
  ] },
  { id: "firewall", title: "Firewall", links: [
    { id: "subnets", href: "/ui/subnets", label: "Подсети", Icon: SubnetsIcon },
    { id: "sets", href: "/ui/sets", label: "Наборы", Icon: SetsIcon },
    { id: "rules", href: "/ui/rules", label: "Правила", Icon: RulesIcon },
    { id: "compile", href: "/ui/compile", label: "Компиляция", Icon: CompileIcon },
  ] },
  { id: "versions", title: "Версии", links: [
    { id: "drafts", href: "/ui/drafts", label: "Черновики", Icon: DraftsIcon },
    { id: "history", href: "/ui/history", label: "История", Icon: HistoryIcon },
  ] },
];

const STANDALONE = [
  { id: "search", href: "/ui/search", label: "Поиск", Icon: SearchIcon },
  { id: "diagnose", href: "/ui/diagnose", label: "Диагностика", Icon: DiagnoseIcon },
  { id: "users", href: "/ui/users", label: "Пользователи", Icon: UsersIcon, adminOnly: true },
];

const navClass = ({ isActive }: { isActive: boolean }) => (isActive ? "active" : undefined);

const NavItem = ({ href, label, Icon }: { href: string; label: string; Icon: () => JSX.Element }) => (
  <NavLink to={href} end className={navClass} data-testid={`nav-${href.slice(4)}`}>
    <span className="icon"><Icon /></span>
    <span className="label">{label}</span>
  </NavLink>
);

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
      <strong className="brand">
        <span className="brand-full">firenet</span>
        <span className="brand-short">F</span>
      </strong>
      <nav className="side-nav">
        {NAV_GROUPS.map((group) => (
          <NavGroup key={group.id} group={group} />
        ))}
        {STANDALONE.filter((l) => !l.adminOnly || isAdmin(me)).map(({ Icon, ...link }) => (
          <NavItem key={link.id} {...link} Icon={Icon} />
        ))}
      </nav>
      <button
        type="button"
        className="sidebar-toggle"
        onClick={toggleSidebar}
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Развернуть меню" : "Свернуть меню"}
      >
        <CollapseIcon collapsed={collapsed} />
      </button>
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
        aria-label={`Свернуть/развернуть раздел «${group.title}»`}
      >
        <span className="icon chevron"><ChevronRightIcon /></span>
        <span className="label">{group.title}</span>
      </button>
      {open && (
        <nav className="side-nav nav-group-links">
          {group.links.map(({ Icon, ...link }) => (
            <NavItem key={link.id} {...link} Icon={Icon} />
          ))}
        </nav>
      )}
    </div>
  );
}

const isAdmin = (me: UserResponse | undefined) => me?.role === "admin";
