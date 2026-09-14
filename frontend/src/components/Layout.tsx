import { Outlet, useLocation } from "react-router-dom";
import { DraftProvider } from "../draft/DraftContext";
import BannerHost from "./BannerHost";
import DraftBanner from "./DraftBanner";
import ErrorBoundary from "./ErrorBoundary";
import Sidebar from "./Sidebar";

// Страницы users и search работают с данными вне драфта, поэтому баннер им не нужен.
const NO_DRAFT_BANNER = new Set(["users", "search"]);

function activeFromPath(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length > 1 ? parts[1] : parts[0] ?? "";
}

export default function Layout() {
  const active = activeFromPath(useLocation().pathname);
  return (
    <DraftProvider>
      <div className="app-shell">
        <Sidebar />
        <div className="app-main">
          <BannerHost />
          {!NO_DRAFT_BANNER.has(active) && <DraftBanner />}
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </div>
      </div>
    </DraftProvider>
  );
}
