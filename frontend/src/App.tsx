import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import CompilePage from "./pages/CompilePage";
import DevicesPage from "./pages/DevicesPage";
import HistoryPage from "./pages/HistoryPage";
import InvitePage from "./pages/InvitePage";
import LinksPage from "./pages/LinksPage";
import LoginPage from "./pages/LoginPage";
import NetworksPage from "./pages/NetworksPage";
import RulesPage from "./pages/RulesPage";
import SearchPage from "./pages/SearchPage";
import SetsPage from "./pages/SetsPage";
import SubnetsPage from "./pages/SubnetsPage";
import UnionsPage from "./pages/UnionsPage";

// Пути 1:1 с легаси-страницами Go. Страницы появляются в задачах 8–20;
// до этого рендерятся заглушки с data-testid="page-<name>".
const routes: Array<[string, string]> = [
  ["/ui/topology", "topology"],
  ["/ui/networks", "networks"],
  ["/ui/devices", "devices"],
  ["/ui/sets", "sets"],
  ["/ui/unions", "unions"],
  ["/ui/links", "links"],
  ["/ui/diagnose", "diagnose"],
  ["/ui/users", "users"],
  ["/ui/drafts", "drafts"],
];

function Placeholder({ name }: { name: string }) {
  return <main className="page" data-testid={`page-${name}`}>{name}</main>;
}

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/ui/topology" replace />} />
        <Route path="/ui/subnets" element={<SubnetsPage />} />
        <Route path="/ui/networks" element={<NetworksPage />} />
        <Route path="/ui/devices" element={<DevicesPage />} />
        <Route path="/ui/sets" element={<SetsPage />} />
        <Route path="/ui/unions" element={<UnionsPage />} />
        <Route path="/ui/links" element={<LinksPage />} />
        <Route path="/ui/rules" element={<RulesPage />} />
        <Route path="/ui/compile" element={<CompilePage />} />
        <Route path="/ui/search" element={<SearchPage />} />
        <Route path="/ui/history" element={<HistoryPage />} />
        {routes.map(([path, name]) => (
          <Route key={path} path={path} element={<Placeholder name={name} />} />
        ))}
        <Route path="*" element={<Placeholder name="notfound" />} />
      </Route>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/invite/:token" element={<InvitePage />} />
    </Routes>
  );
}
