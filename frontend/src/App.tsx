import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";

// Пути 1:1 с легаси-страницами Go. Страницы появляются в задачах 8–20;
// до этого рендерятся заглушки с data-testid="page-<name>".
const routes: Array<[string, string]> = [
  ["/ui/topology", "topology"],
  ["/ui/subnets", "subnets"],
  ["/ui/networks", "networks"],
  ["/ui/devices", "devices"],
  ["/ui/sets", "sets"],
  ["/ui/unions", "unions"],
  ["/ui/links", "links"],
  ["/ui/rules", "rules"],
  ["/ui/compile", "compile"],
  ["/ui/diagnose", "diagnose"],
  ["/ui/users", "users"],
  ["/ui/drafts", "drafts"],
  ["/ui/history", "history"],
  ["/ui/search", "search"],
];

function Placeholder({ name }: { name: string }) {
  return <main className="page" data-testid={`page-${name}`}>{name}</main>;
}

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/ui/topology" replace />} />
        {routes.map(([path, name]) => (
          <Route key={path} path={path} element={<Placeholder name={name} />} />
        ))}
        <Route path="*" element={<Placeholder name="notfound" />} />
      </Route>
      <Route path="/login" element={<Placeholder name="login" />} />
      <Route path="/invite/:token" element={<Placeholder name="invite" />} />
    </Routes>
  );
}
