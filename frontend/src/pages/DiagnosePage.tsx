import { useCallback, useEffect, useMemo, useState } from "react";
import { useDiagnose, useProjectResource, useSpread } from "../api/queries";
import type { DiagnoseReport, LayoutDoc, MapMark, SpreadResult, TopologyDoc } from "../api/types";
import { layoutLinkKey } from "../lib/links";
import TopologyCanvas from "../topology/TopologyCanvas";
import { notify } from "../components/notify";
import { ResetIcon } from "../components/icons";
import { storageKeys } from "../lib/storage";

const FORM_KEY = storageKeys.diagForm;
const EMPTY_TOPOLOGY: TopologyDoc = { devices: [], links: [], networks: [], sets: [], unions: [] };

type Form = { src: string; dst: string; proto: string; dstPorts: string };
type SpreadForm = { src: string };

const VERDICT_LABEL: Record<string, string> = {
  allow: "разрешено", deny: "запрещено", return: "возврат в FORWARD",
};

export default function DiagnosePage() {
  const topology = useProjectResource<TopologyDoc>("topology");
  const layoutQuery = useProjectResource<LayoutDoc>("layout");
  const diagnose = useDiagnose();
  const spread = useSpread();

  const [form, setForm] = useState<Form>(() => readForm());
  const [spreadForm, setSpreadForm] = useState<SpreadForm>({ src: "" });
  const [panel, setPanel] = useState<"path" | "spread">("path");
  const [report, setReport] = useState<DiagnoseReport | null>(null);
  const [spreadMark, setSpreadMark] = useState<MapMark | null>(null);
  const [spreadData, setSpreadData] = useState<SpreadResult | null>(null);

  const doc = topology.data ?? EMPTY_TOPOLOGY;
  const layout = layoutQuery.data ?? {};

  // Форма переживает перезагрузку страницы: поля диагностики долго вводить.
  useEffect(() => {
    localStorage.setItem(FORM_KEY, JSON.stringify(form));
  }, [form]);

  const runDiagnose = async () => {
    try {
      const result = await diagnose.mutateAsync({
        src: form.src.trim(),
        dst: form.dst.trim(),
        proto: form.proto as "" | "tcp" | "udp" | "icmp",
        srcPorts: [],
        dstPorts: form.dstPorts.split(",").map((p) => p.trim()).filter(Boolean),
      });
      setReport(result);
      setSpreadMark(null);
      setSpreadData(null);
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const runSpread = async () => {
    try {
      const result = await spread.mutateAsync({
        src: spreadForm.src.trim(), proto: "", dstPorts: [],
      });
      setSpreadMark(result.mark);
      setSpreadData(result);
      setReport(null);
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const reset = () => {
    setReport(null);
    setSpreadMark(null);
    setSpreadData(null);
  };

  // Ключи okE/halfE/denyE приходят с NUL-разделителем — тот же формат, что
  // использовала самописная канва. Рёбра в канве живут под id
  // link:<канонический ключ>#<offset> (buildScene в Task 17/18), поэтому
  // здесь ключ строится без суффикса, а markOf сопоставляет по префиксу.
  const mark = useMemo(() => buildMark(report?.mapMark ?? spreadMark), [report, spreadMark]);

  // Узлы в канве имеют id ровно device:<имя>/network:<имя>, так что на них
  // mark ставится прямым соответствием. Рёбра же идут с суффиксом
  // «#<offset>» (параллельные связи), поэтому ищем по префиксу
  // link:<ключ>, где <ключ> — из mapMark (NUL-разделитель → layoutLinkKey).
  const markOf = useCallback((id: string) => {
    const direct = mark.get(id);
    if (direct) return direct;
    if (id.startsWith("link:")) {
      const base = id.slice(0, id.lastIndexOf("#"));
      const fromBase = mark.get(base);
      if (fromBase) return fromBase;
      const slash = id.indexOf(":");
      const a = id.slice(slash + 1, id.indexOf("|"));
      const b = id.slice(id.indexOf("|") + 1, id.lastIndexOf("#"));
      return mark.get(`link:${layoutLinkKey(a, b)}`);
    }
    return undefined;
  }, [mark]);

  return (
    <main className="page" data-testid="page-diagnose">
      <div className="topology-layout">
        <TopologyCanvas topology={doc} layout={layout} editable={false} markOf={markOf}>
          <div className="topo-toolbar">
            <button type="button" data-testid="tool-path" className={`tool${panel === "path" ? " active" : ""}`} title="Диагностика пути" onClick={() => setPanel("path")} />
            <button type="button" data-testid="tool-spread" className={`tool${panel === "spread" ? " active" : ""}`} title="Распространение" onClick={() => setPanel("spread")} />
            <span className="toolbar-sep" />
            <button type="button" className="tool" title="Сбросить" disabled={!report && !spreadMark} onClick={reset}>
              <ResetIcon />
            </button>
          </div>

          {panel === "path" ? (
            <form
              className="diag-panel floating-panel"
              data-testid="diag-panel"
              onSubmit={(event) => { event.preventDefault(); void runDiagnose(); }}
            >
              <header className="floating-panel-header">
                <strong>Диагностика пути</strong>
              </header>
              <div className="floating-panel-body">
                <label>
                  Источник
                  <input value={form.src} onChange={(e) => setForm({ ...form, src: e.target.value })} placeholder="10.0.0.5" />
                </label>
                <label>
                  Назначение
                  <input value={form.dst} onChange={(e) => setForm({ ...form, dst: e.target.value })} placeholder="10.0.1.5" />
                </label>
                <label>
                  Протокол
                  <select value={form.proto} onChange={(e) => setForm({ ...form, proto: e.target.value })}>
                    <option value="">любой</option>
                    <option value="tcp">tcp</option>
                    <option value="udp">udp</option>
                    <option value="icmp">icmp</option>
                  </select>
                </label>
                <label>
                  Порты назначения
                  <input value={form.dstPorts} onChange={(e) => setForm({ ...form, dstPorts: e.target.value })} placeholder="80,443" />
                </label>
                <div className="modal-actions">
                  <button type="submit" className="primary" disabled={diagnose.isPending || !form.src.trim() || !form.dst.trim()}>
                    Проверить путь
                  </button>
                </div>
              </div>
            </form>
          ) : (
            <form
              className="diag-panel floating-panel"
              data-testid="spread-panel"
              onSubmit={(event) => { event.preventDefault(); void runSpread(); }}
            >
              <header className="floating-panel-header">
                <strong>Распространение сети</strong>
              </header>
              <div className="floating-panel-body">
                <label>
                  Источник (сеть, подсеть или IP)
                  <input value={spreadForm.src} onChange={(e) => setSpreadForm({ src: e.target.value })} placeholder="lan" />
                </label>
                <div className="modal-actions">
                  <button type="submit" className="primary" disabled={spread.isPending || !spreadForm.src.trim()}>
                    Проверить доступность
                  </button>
                </div>
              </div>
            </form>
          )}
        </TopologyCanvas>

        {report && (
          <div className="page-panel" data-testid="diag-report">
            <p>{`${report.srcSubnet} → ${report.dstSubnet}: путей ${report.paths.length}. ${report.note}`}</p>
            {!report.returnPathAllowed && (
              <p className="diag-halfpath">Доступность только в одну сторону: обратный путь закрыт.</p>
            )}
            {report.paths.map((path, i) => (
              <section className="diag-path" key={i}>
                <span className="badge">{VERDICT_LABEL[path.verdict] ?? path.verdict}</span>
                {path.note && <p className="diag-note">{path.note}</p>}
                <div className="diag-chain">
                  {path.nodes.map((n, j) => (
                    <span key={j}>
                      {j > 0 && <span className="diag-arrow">→</span>}
                      <span className={`diag-chip${n.kind === 0 ? " diag-chip-router" : ""}`}>{n.name}</span>
                    </span>
                  ))}
                </div>
                {path.routers.map((r) => (
                  <details className="diag-verdict" key={r.router}>
                    <summary>{`${r.router}: ${r.action}${r.matchedRule ? ` (${r.matchedRule})` : ""}`}</summary>
                    {r.steps?.length
                      ? <ol className="diag-steps">{r.steps.map((s, k) => <li key={k}>{s}</li>)}</ol>
                      : <p>{r.reason}</p>}
                  </details>
                ))}
              </section>
            ))}
            {report.paths.length === 0 && <p className="diag-unreachable">Путей нет.</p>}
          </div>
        )}

        {spreadData && (
          <div className="page-panel" data-testid="spread-report">
            <p>
              {`Источник: ${spreadData.sources.map((s) => s.SubnetName || s.IP).join(", ")}. ` +
                `Достижимо ${spreadData.reports.filter((r) => (r.report?.paths.length ?? 0) > 0).length} из ${spreadData.reports.length} подсетей.`}
            </p>
          </div>
        )}
      </div>
    </main>
  );
}

function readForm(): Form {
  try {
    const raw = localStorage.getItem(FORM_KEY);
    if (!raw) return { src: "", dst: "", proto: "", dstPorts: "" };
    const parsed = JSON.parse(raw) as Partial<Form>;
    return {
      src: parsed.src ?? "", dst: parsed.dst ?? "",
      proto: parsed.proto ?? "", dstPorts: parsed.dstPorts ?? "",
    };
  } catch {
    return { src: "", dst: "", proto: "", dstPorts: "" };
  }
}

// mapMark приходит с сервера в виде списков имён; здесь он превращается в
// соответствие «id узла/ребра → класс подсветки». Узлы индексируются точно
// (device:<имя>, network:<имя>), рёбра — по каноническому ключу без
// суффикса #<offset> (см. markOf выше).
function buildMark(mark: MapMark | null | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (!mark) return result;
  for (const id of mark.ok ?? []) result.set(id, "diag-flow-ok");
  for (const id of mark.half ?? []) result.set(id, "diag-flow-half");
  for (const name of Object.keys(mark.deny ?? {})) result.set(`device:${name}`, "diag-flow-deny");
  for (const key of mark.okE ?? []) {
    const [a, b] = key.split("\0");
    if (a && b) result.set(`link:${layoutLinkKey(a, b)}`, "diag-flow-ok");
  }
  for (const key of mark.halfE ?? []) {
    const [a, b] = key.split("\0");
    if (a && b) result.set(`link:${layoutLinkKey(a, b)}`, "diag-flow-half");
  }
  for (const key of mark.denyE ?? []) {
    const [a, b] = key.split("\0");
    if (a && b) result.set(`link:${layoutLinkKey(a, b)}`, "diag-flow-deny");
  }
  return result;
}
