// Глифы кнопок — перенесены 1:1 из легаси-шаблонов (users.html/subnets.html/
// topology.html). Кнопки .icon-btn/.tool пустые без svg: inline-flex схлопы-
// вается в нулевую высоту и кнопка становится невидимой.

import type { ReactNode } from "react";

const editPath = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11.3 2.1a1.6 1.6 0 0 1 2.3 2.3L5.4 12.6l-3.1.8.8-3.1z" />
  </svg>
);

const deletePath = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.5 4h11" />
    <path d="M5.5 4V2.7c0-.4.3-.7.7-.7h3.6c.4 0 .7.3.7.7V4" />
    <path d="M3.5 4l.6 9.3c0 .4.4.7.8.7h6.2c.4 0 .8-.3.8-.7L12.5 4" />
    <path d="M6.5 6.8v4.4" />
    <path d="M9.5 6.8v4.4" />
  </svg>
);

export const EditIcon = () => editPath;
export const DeleteIcon = () => deletePath;

const toolOpen = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export const SearchIcon = () => (
  <svg {...toolOpen}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.8-3.8" />
  </svg>
);

export const TrashIcon = () => (
  <svg {...toolOpen}>
    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
  </svg>
);

export const SelectIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M5 3l14 8-6 1.6L9.4 19z" />
  </svg>
);

export const ConnectIcon = () => (
  <svg {...toolOpen}>
    <path d="M7 12c3-6 7 6 10 0" />
    <circle cx="4" cy="12" r="2" fill="currentColor" stroke="none" />
    <circle cx="20" cy="12" r="2" fill="currentColor" stroke="none" />
  </svg>
);

export const DeviceToolIcon = () => (
  <svg {...toolOpen}>
    <rect x="5" y="3" width="14" height="18" rx="1.5" />
    <path d="M5 9h14M5 15h14" />
    <circle cx="8" cy="6" r="0.6" fill="currentColor" />
    <circle cx="11" cy="6" r="0.6" fill="currentColor" />
    <circle cx="8" cy="12" r="0.6" fill="currentColor" />
    <circle cx="11" cy="12" r="0.6" fill="currentColor" />
    <circle cx="8" cy="18" r="0.6" fill="currentColor" />
    <circle cx="11" cy="18" r="0.6" fill="currentColor" />
  </svg>
);

export const NetworkToolIcon = () => (
  <svg {...toolOpen}>
    <path d="M17.5 19a4.5 4.5 0 0 0 .34-8.99A6 6 0 0 0 6.2 11.6 4 4 0 0 0 7 19z" />
  </svg>
);

export const ResetIcon = () => (
  <svg {...toolOpen} strokeWidth={1.3}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const SunIcon = () => (
  <svg {...toolOpen}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);

export const MoonIcon = () => (
  <svg {...toolOpen}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </svg>
);

export const CollapseIcon = () => (
  <svg {...toolOpen}>
    <path d="M15 6l-6 6 6 6" />
  </svg>
);

export const MoveUpIcon = () => (
  <svg {...toolOpen} strokeWidth={1.6}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
);

export const MoveDownIcon = () => (
  <svg {...toolOpen} strokeWidth={1.6}>
    <path d="M12 5v14M19 12l-7 7-7-7" />
  </svg>
);

// Иконки левого меню — перенос 1:1 из легаси common.js (NAV_ICONS).
const navIcon = (shape: ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {shape}
  </svg>
);

export const TopologyIcon = () =>
  navIcon(
    <>
      <circle cx="5" cy="6" r="2" />
      <circle cx="19" cy="6" r="2" />
      <circle cx="12" cy="18" r="2" />
      <path d="M7 7l3.5 9M17 7l-3.5 9M7 6h10" />
    </>,
  );

export const DevicesIcon = () =>
  navIcon(
    <>
      <rect x="4" y="4" width="16" height="10" rx="1" />
      <path d="M8 18h8M12 14v4" />
    </>,
  );

export const SubnetsIcon = () =>
  navIcon(
    <>
      <rect x="3" y="3" width="8" height="8" rx="1" />
      <rect x="13" y="3" width="8" height="8" rx="1" />
      <rect x="3" y="13" width="8" height="8" rx="1" />
      <rect x="13" y="13" width="8" height="8" rx="1" />
    </>,
  );

export const NetworksIcon = () =>
  navIcon(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z" />
    </>,
  );

export const SetsIcon = () => navIcon(<path d="M4 6h16M4 12h16M4 18h10" />);

export const UnionsIcon = () =>
  navIcon(
    <>
      <rect x="3" y="3" width="12" height="12" rx="1" />
      <rect x="9" y="9" width="12" height="12" rx="1" />
    </>,
  );

export const LinksIcon = () =>
  navIcon(
    <>
      <path d="M10 14a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07L11 5.93" />
      <path d="M14 10a5 5 0 0 0-7.07 0l-2.12 2.12a5 5 0 0 0 7.07 7.07L13 18.07" />
    </>,
  );

export const RulesIcon = () =>
  navIcon(<path d="M12 3l8 3v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-3z" />);

export const CompileIcon = () =>
  navIcon(
    <>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </>,
  );

export const DiagnoseIcon = () =>
  navIcon(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </>,
  );

export const UsersIcon = () =>
  navIcon(
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
      <path d="M17 8a3 3 0 1 1 0 6" />
      <path d="M21 20c0-2.5-1.6-4.6-4-5.5" />
    </>,
  );

export const DraftsIcon = () =>
  navIcon(
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </>,
  );

export const HistoryIcon = () =>
  navIcon(
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
      <path d="M12 7v5l3 3" />
    </>,
  );

export const ChevronRightIcon = () => navIcon(<polyline points="9 18 15 12 9 6" />);
