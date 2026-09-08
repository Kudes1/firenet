import { useCompile } from "../api/queries";
import type { CompiledDevice } from "../api/types";

export default function CompilePage() {
  const compile = useCompile();
  const devices = compile.data ?? [];

  return (
    <main className="page" data-testid="page-compile">
      <div className="table-toolbar">
        <div className="toolbar-text">
          <h3>Компиляция</h3>
          <p className="hint">Правила iptables и ipset для каждого устройства.</p>
        </div>
        <div className="toolbar-actions">
          <button id="compile-run" type="button" className="primary" disabled={compile.isPending} onClick={() => compile.mutate()}>
            {compile.isPending ? "Компиляция…" : "Скомпилировать"}
          </button>
        </div>
      </div>
      {compile.error && <p className="cell-hint">{(compile.error as Error).message}</p>}
      <div id="compile-output">
        {devices.map((device) => <DeviceScripts key={device.Name} device={device} />)}
      </div>
    </main>
  );
}

function DeviceScripts({ device }: { device: CompiledDevice }) {
  return (
    <section className="compile-device">
      <h2>{device.Name}</h2>
      {[
        { title: "ipset", text: device.IPSetsScript, suffix: "ipsets.restore" },
        { title: "iptables", text: device.RulesScript, suffix: "rules.sh" },
      ].map(({ title, text, suffix }) => (
        <div key={title}>
          <h3>{title}</h3>
          <pre>{text}</pre>
          <a download={`${device.Name}.${suffix}`} href={objectURL(text)}>Скачать {title}</a>
        </div>
      ))}
    </section>
  );
}

// Blob-URL, как в легаси: скачивание готового скрипта без отдельного
// эндпоинта на бэкенде.
function objectURL(text: string): string {
  return URL.createObjectURL(new Blob([text], { type: "text/plain" }));
}
