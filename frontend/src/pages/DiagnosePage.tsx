import { useEffect, useMemo, useState } from "react";
import { useDiagnose, useProjectResource, useSpread } from "../api/queries";
import type { DiagnoseReport, LayoutDoc, MapMark, SpreadResult, SubnetsDoc, TopologyDoc } from "../api/types";
import { diagnosticMarkOf } from "../lib/diagnoseMarks";
import TopologyCanvas from "../topology/TopologyCanvas";
import { notify } from "../components/notify";
import { DiagnosePathIcon, DiagnoseSpreadIcon, ResetIcon } from "../components/icons";
import Modal from "../components/ui/Modal";
import { storageKeys } from "../lib/storage";

const FORM_KEY = storageKeys.diagForm;
const EMPTY_TOPOLOGY: TopologyDoc = { devices: [], links: [], networks: [], sets: [], unions: [] };

type Form = { src: string; dst: string; proto: string; dstPorts: string };
type SpreadForm = { src: string };
type Tool = "path" | "spread";

const VERDICT_LABEL: Record<string, string> = {
  allow: "разрешено", deny: "запрещено", return: "возврат в FORWARD",
};

export default function DiagnosePage() {
  const topology = useProjectResource<TopologyDoc>("topology");
  const layoutQuery = useProjectResource<LayoutDoc>("layout");
  const subnets = useProjectResource<SubnetsDoc>("subnets");
  const diagnose = useDiagnose();
  const spread = useSpread();

  const [form, setForm] = useState<Form>(() => readForm());
  const [spreadForm, setSpreadForm] = useState<SpreadForm>({ src: "" });
  const [activeTool, setActiveTool] = useState<Tool | null>(null);
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

  const toggleTool = (tool: Tool) => {
    setActiveTool((current) => current === tool ? null : tool);
  };

  const markOf = useMemo(
    () => diagnosticMarkOf(report?.mapMark ?? spreadMark),
    [report?.mapMark, spreadMark],
  );

  return (
    <main className="page" data-testid="page-diagnose">
      <div className="topology-layout">
        <TopologyCanvas
          topology={doc}
          layout={layout}
          subnets={subnets.data?.subnets ?? []}
          editable={false}
          markOf={markOf}
        >
          <div className="topo-toolbar">
            <button
              type="button"
              data-testid="tool-path"
              className={`tool${activeTool === "path" ? " active" : ""}`}
              title="Диагностика пути"
              aria-label="Диагностика пути"
              aria-pressed={activeTool === "path"}
              onClick={() => toggleTool("path")}
            >
              <DiagnosePathIcon />
            </button>
            <button
              type="button"
              data-testid="tool-spread"
              className={`tool${activeTool === "spread" ? " active" : ""}`}
              title="Распространение"
              aria-label="Распространение"
              aria-pressed={activeTool === "spread"}
              onClick={() => toggleTool("spread")}
            >
              <DiagnoseSpreadIcon />
            </button>
            <span className="toolbar-sep" />
            <button
              type="button"
              className="tool"
              title="Сбросить"
              aria-label="Сбросить результат"
              disabled={!report && !spreadMark}
              onClick={reset}
            >
              <ResetIcon />
            </button>
          </div>
        </TopologyCanvas>

        <Modal
          open={activeTool !== null}
          modal={false}
          compact={activeTool === "path"}
          resizable={activeTool !== null}
          resizeStorageKey={storageKeys.diagModalSize}
          title={activeTool === "path" ? "Диагностика пути" : "Распространение сети"}
          onClose={() => setActiveTool(null)}
        >
          {activeTool === "path" && (
            <form
              data-testid="diag-panel"
              onSubmit={(event) => { event.preventDefault(); void runDiagnose(); }}
            >
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
            </form>
          )}
          {activeTool === "spread" && (
            <form
              data-testid="spread-panel"
              onSubmit={(event) => { event.preventDefault(); void runSpread(); }}
            >
              <label>
                Источник (сеть, подсеть или IP)
                <input value={spreadForm.src} onChange={(e) => setSpreadForm({ src: e.target.value })} placeholder="lan" />
              </label>
              <div className="modal-actions">
                <button type="submit" className="primary" disabled={spread.isPending || !spreadForm.src.trim()}>
                  Проверить доступность
                </button>
              </div>
            </form>
          )}
          {activeTool === "path" && report && (
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
          {activeTool === "spread" && spreadData && (
            <div className="page-panel" data-testid="spread-report">
              <p>
                {`Источник: ${spreadData.sources.map((s) => s.SubnetName || s.IP).join(", ")}. ` +
                  `Достижимо ${spreadData.reports.filter((r) => (r.report?.paths.length ?? 0) > 0).length} из ${spreadData.reports.length} подсетей.`}
              </p>
            </div>
          )}
        </Modal>
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
