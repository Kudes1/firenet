import { useMemo, useState } from "react";
import { useLint, useProjectResource, useProjectSave } from "../api/queries";
import type { ChainDoc, PolicyDoc, RuleDoc, SubnetsDoc, TopologyDoc } from "../api/types";
import { useDraft } from "../draft/DraftContext";
import { validPortSpec } from "../lib/validate";
import Combo from "../components/ui/Combo";
import MemberList from "../components/ui/MemberList";
import Modal from "../components/ui/Modal";
import { notify } from "../components/notify";
import { DeleteIcon, EditIcon } from "../components/icons";

type RuleDraft = {
  index: number; name: string; comment: string; src: string[]; dst: string[];
  proto: string; srcPorts: string; dstPorts: string; action: string; jumpTo: string; mirror: boolean;
};

const PROTOS = ["any", "tcp", "udp", "icmp"];
const ACTIONS = ["allow", "deny", "return", "jump"];

export default function RulesPage() {
  const { isReadOnly } = useDraft();
  const rules = useProjectResource<PolicyDoc>("rules");
  const topology = useProjectResource<TopologyDoc>("topology");
  const subnets = useProjectResource<SubnetsDoc>("subnets");
  // Правка правил делает невалидными lint и search-index.
  const save = useProjectSave<PolicyDoc>("rules", { invalidate: ["lint", "search-index"] });
  const lint = useLint();

  const [active, setActive] = useState(0);
  const [editing, setEditing] = useState<RuleDraft | null>(null);
  const [chainEditing, setChainEditing] = useState(false);
  const [chainDraft, setChainDraft] = useState<ChainDoc | null>(null);
  const [highlighted, setHighlighted] = useState<string[]>([]);
  // Крестик прячет панель до следующего «Проверить» (как lintOpen в rules.js:
  // refetch в легаси заново открывал панель — здесь роль lintOpen играет
  // отсутствие refetch после закрытия).
  const [lintOpen, setLintOpen] = useState(false);
  const findings = lint.data?.findings ?? [];
  const showLint = lintOpen && findings.length > 0;

  const chains = rules.data?.chains ?? [];
  const chain = chains[active];
  const totalRules = chains.reduce((total, item) => total + item.rules.length, 0);

  const endpoints = useMemo(() => [
    "any",
    ...(subnets.data?.subnets ?? []).map((s) => s.name).sort(),
    ...(topology.data?.sets ?? []).map((s) => s.name).sort(),
  ], [subnets.data, topology.data]);

  const persist = async (next: PolicyDoc) => {
    try {
      await save.mutateAsync(next);
      notify("Правила сохранены", "ok");
      return true;
    } catch (error) {
      notify((error as Error).message);
      return false;
    }
  };

  const openRule = (index: number) => {
    if (isReadOnly) {
      notify("Только чтение — откройте черновик, чтобы редактировать");
      return;
    }
    const r = chain?.rules[index];
    setEditing(r ? {
      index, name: r.name, comment: r.comment ?? "", src: r.src, dst: r.dst,
      proto: r.proto || "any", srcPorts: (r.srcPorts ?? []).join(","), dstPorts: (r.dstPorts ?? []).join(","),
      action: r.action, jumpTo: r.jumpTo ?? "", mirror: r.mirror ?? false,
    } : {
      index: -1, name: "", comment: "", src: [], dst: [], proto: "any",
      srcPorts: "", dstPorts: "", action: "allow", jumpTo: "", mirror: false,
    });
  };

  const hints = editing ? ruleHint(editing, chain) : [];

  const submitRule = () => {
    if (!editing || !rules.data) return;
    const rule: RuleDoc = {
      name: editing.name.trim(),
      src: editing.src,
      dst: editing.dst,
      proto: editing.proto,
      action: editing.action as RuleDoc["action"],
    };
    if (editing.comment.trim()) rule.comment = editing.comment.trim();
    if (editing.srcPorts.trim()) rule.srcPorts = splitPorts(editing.srcPorts);
    if (editing.dstPorts.trim()) rule.dstPorts = splitPorts(editing.dstPorts);
    if (editing.action === "jump") rule.jumpTo = editing.jumpTo;
    if (editing.mirror) rule.mirror = true;

    const nextChains = chains.map((c, i) => {
      if (i !== active) return c;
      const list = c.rules.slice();
      if (editing.index >= 0) list[editing.index] = rule;
      else list.push(rule);
      return { ...c, rules: list };
    });
    void persist({ chains: nextChains }).then((ok) => { if (ok) setEditing(null); });
  };

  const moveRule = (index: number, delta: number) => {
    if (!rules.data || !chain) return;
    const target = index + delta;
    if (target < 0 || target >= chain.rules.length) return;
    const list = chain.rules.slice();
    [list[index], list[target]] = [list[target], list[index]];
    void persist({ chains: chains.map((c, i) => (i === active ? { ...c, rules: list } : c)) });
  };

  const removeRule = (index: number) => {
    if (!rules.data || !chain) return;
    if (!window.confirm(`Удалить правило ${chain.rules[index].name}?`)) return;
    void persist({
      chains: chains.map((c, i) => (i === active ? { ...c, rules: c.rules.filter((_, j) => j !== index) } : c)),
    });
  };

  const addChain = () => {
    if (isReadOnly) {
      notify("Только чтение — откройте черновик, чтобы редактировать");
      return;
    }
    if (!rules.data) return;
    void persist({ chains: [...chains, { name: "new-chain", defaultAction: "deny", rules: [] }] }).then((ok) => {
      if (!ok) return;
      setActive(chains.length);
      setChainDraft({ name: "new-chain", defaultAction: "deny", rules: [] });
      setChainEditing(true);
    });
  };

  const removeChain = (index: number) => {
    if (!rules.data || index === 0) return;
    const name = chains[index].name;
    if (chains.some((c) => c.rules.some((r) => r.jumpTo === name))) {
      notify(`Цепочка ${name} используется действием jump`);
      return;
    }
    if (!window.confirm(`Удалить цепочку ${name}?`)) return;
    void persist({ chains: chains.filter((_, i) => i !== index) });
    setActive((current) => (current > index ? current - 1 : 0));
  };

  const submitChain = () => {
    if (!chainDraft || !rules.data) return;
    if (!chainDraft.name.trim()) {
      notify("Имя цепочки обязательно");
      return;
    }
    void persist({ chains: chains.map((c, i) => (i === active ? chainDraft : c)) });
    setChainEditing(false);
    setChainDraft(null);
  };

  const jumpToFinding = (rulesNames: string[] | undefined, chainName: string) => {
    const index = chains.findIndex((c) => c.name === chainName);
    if (index >= 0) setActive(index);
    setHighlighted(rulesNames ?? []);
    setTimeout(() => setHighlighted([]), 2000);
  };

  if (!chain) {
    return <main className="page" data-testid="page-rules"><p className="hint">Правила не загружены</p></main>;
  }

  return (
    <main className="page rules-page" data-testid="page-rules">
      <header className="rules-page-header">
        <div className="rules-heading">
          <h1>Правила</h1>
          <p className="hint">Цепочки фильтрации трафика для устройств топологии.</p>
        </div>
        <div className="rules-page-summary" aria-label="Сводка по правилам">
          <span><strong>{chains.length}</strong> {chains.length === 1 ? "цепочка" : "цепочек"}</span>
          <span><strong>{totalRules}</strong> {totalRules === 1 ? "правило" : "правил"}</span>
        </div>
      </header>

      <section className="rules-chain-surface" aria-label="Цепочки правил">
        <div className="rules-chain-header">
          <div>
            <span className="rules-eyebrow">Цепочка</span>
            <strong>{chain.name || "—"}</strong>
          </div>
          <button type="button" className="chain-tab-add" onClick={addChain}>+ цепочка</button>
        </div>

        <div className="chain-tabs" data-testid="chain-tabs">
          {chains.map((c, i) => (
            <span className={`chain-tab${i === active ? " active" : ""}`} key={c.name || i}>
              <button type="button" aria-current={i === active ? "page" : undefined} onClick={() => setActive(i)}>{c.name || "—"}</button>
              {i > 0 && (
                <button type="button" className="chain-tab-remove" title={`Удалить цепочку ${c.name}`} onClick={() => removeChain(i)}>×</button>
              )}
            </span>
          ))}
        </div>

        <div className="rules-settings-group">
          {chainEditing && chainDraft ? (
            <>
              <label>
                Имя
                <input value={chainDraft.name} onChange={(e) => setChainDraft({ ...chainDraft, name: e.target.value })} />
              </label>
              <label>
                Действие по умолчанию
                <select value={chainDraft.defaultAction} onChange={(e) => setChainDraft({ ...chainDraft, defaultAction: e.target.value })}>
                  {["deny", "allow", "return"].map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </label>
              {active === 0 && (
                <label>
                  Позиция
                  <select
                    value={chainDraft.chainPosition ?? "top"}
                    onChange={(e) => setChainDraft({ ...chainDraft, chainPosition: e.target.value as "top" | "bottom" })}
                  >
                    <option value="top">top</option>
                    <option value="bottom">bottom</option>
                  </select>
                </label>
              )}
              <div className="settings-edit-actions">
                <button type="button" onClick={() => { setChainEditing(false); setChainDraft(null); }}>Отмена</button>
                <button type="button" className="primary" onClick={submitChain}>Сохранить</button>
              </div>
            </>
          ) : (
            <>
              <span className="settings-badge">Действие: <strong>{chain.defaultAction}</strong></span>
              {active === 0 && <span className="settings-badge">Позиция: <strong>{chain.chainPosition ?? "top"}</strong></span>}
              <button type="button" onClick={() => { setChainDraft(chain); setChainEditing(true); }}>⚙ Изменить параметры</button>
            </>
          )}
        </div>
      </section>

      <section className="rules-table-surface" data-testid="rules-table-surface">
        <div className="table-toolbar">
          <div className="toolbar-text rules-table-heading">
            <span className="rules-eyebrow">{chain.name || "—"}</span>
            <h2>Правила</h2>
            <span className="rules-count">{chain.rules.length} {chain.rules.length === 1 ? "правило" : "правил"}</span>
          </div>
          <div className="toolbar-actions">
            <button type="button" onClick={() => { setLintOpen(true); void lint.refetch(); }}>Проверить</button>
            <button type="button" className="primary" title="Добавить правило" onClick={() => openRule(-1)}>+ Правило</button>
          </div>
        </div>

        {showLint && (
          <div className="lint-panel" data-testid="lint-panel">
            <div className="lint-panel-header">
              <strong>Замечания</strong>
              <button type="button" className="lint-panel-close" onClick={() => setLintOpen(false)}>×</button>
            </div>
            <div className="lint-panel-body">
              {findings.map((f, i) => (
                <button type="button" className="lint-finding" key={i} onClick={() => jumpToFinding(f.rules, f.chain)}>
                  <span className={`badge badge-${f.severity === "warning" ? "warn" : "info"}`}>{f.severity}</span>
                  <span className="lint-finding-chain">{f.chain}</span>
                  <span className="lint-finding-msg">{f.message}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="rules-table-scroll">
          <table className="data-table" id="rules-table" data-testid="rules-table">
            <thead>
              <tr>
                <th /><th>Имя</th><th>Комментарий</th><th>Src</th><th>Dst</th>
                <th>Proto</th><th>Src Ports</th><th>Dst Ports</th><th>Action</th><th>Зеркало</th><th />
              </tr>
            </thead>
            <tbody>
              {chain.rules.map((r, i) => (
                <tr key={r.name} className={highlighted.includes(r.name) ? "lint-highlighted" : undefined}>
                  <td className="row-index-cell">
                    <button type="button" className="icon-btn move" title={`Переместить правило ${r.name} выше`} onClick={() => moveRule(i, -1)} disabled={i === 0}>▲</button>
                    <button type="button" className="icon-btn move" title={`Переместить правило ${r.name} ниже`} onClick={() => moveRule(i, 1)} disabled={i === chain.rules.length - 1}>▼</button>
                  </td>
                  <td className="rule-name">{r.name}</td>
                  <td className="rule-comment">{r.comment || "—"}</td>
                  <td className="rule-members">{r.src.length ? r.src.map((member, index) => <span className="rule-member" key={`${member}-${index}`}>{member}</span>) : <span className="rule-member rule-member-empty">any</span>}</td>
                  <td className="rule-members">{r.dst.length ? r.dst.map((member, index) => <span className="rule-member" key={`${member}-${index}`}>{member}</span>) : <span className="rule-member rule-member-empty">any</span>}</td>
                  <td><span className="rule-proto">{r.proto || "any"}</span></td>
                  <td className="rule-ports">{(r.srcPorts ?? []).join(",") || "—"}</td>
                  <td className="rule-ports">{(r.dstPorts ?? []).join(",") || "—"}</td>
                  <td><span className={`rule-action rule-action-${r.action}`}>{r.action}{r.jumpTo ? ` → ${r.jumpTo}` : ""}</span></td>
                  <td>{r.mirror ? <span className="rule-mirror">да</span> : <span className="hint">—</span>}</td>
                  <td>
                    <div className="rule-actions">
                      <button type="button" className="icon-btn rule-action-button edit" title={`Изменить правило ${r.name}`} aria-label={`Изменить правило ${r.name}`} onClick={() => openRule(i)}><EditIcon /></button>
                      <button type="button" className="icon-btn rule-action-button delete" title={`Удалить правило ${r.name}`} aria-label={`Удалить правило ${r.name}`} onClick={() => removeRule(i)}><DeleteIcon /></button>
                    </div>
                  </td>
                </tr>
              ))}
              {chain.rules.length === 0 && (
                <tr><td className="empty-cell" colSpan={11}>Правил нет — добавьте первое</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <Modal
        open={!!editing}
        wide
        title={editing && editing.index >= 0 ? "Изменить правило" : "Новое правило"}
        onClose={() => setEditing(null)}
        footer={
          <>
            <button type="button" onClick={() => setEditing(null)}>Отмена</button>
            <button type="button" className="primary" disabled={!!hints.length || save.isPending} onClick={submitRule}>Сохранить</button>
          </>
        }
      >
        {editing && (
          <div className="modal-grid">
            <label>Имя<input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
            <label>Комментарий<input value={editing.comment} onChange={(e) => setEditing({ ...editing, comment: e.target.value })} /></label>
            {/* div, а не label: label пересылает клик по строке участника кнопке «×». */}
            <div className="modal-field">
              Src
              <MemberList
                members={editing.src}
                onRemove={(n) => setEditing({ ...editing, src: editing.src.filter((x) => x !== n) })}
                empty="—"
              />
              <Combo items={endpoints} placeholder="any, подсеть или набор" onPick={(n) => {
                if (editing.src.includes(n)) return;
                setEditing({ ...editing, src: [...editing.src, n] });
              }} />
            </div>
            <div className="modal-field">
              Dst
              <MemberList
                members={editing.dst}
                onRemove={(n) => setEditing({ ...editing, dst: editing.dst.filter((x) => x !== n) })}
                empty="—"
              />
              <Combo items={endpoints} placeholder="any, подсеть или набор" onPick={(n) => {
                if (editing.dst.includes(n)) return;
                setEditing({ ...editing, dst: [...editing.dst, n] });
              }} />
            </div>
            <label>Протокол
              <select value={editing.proto} onChange={(e) => setEditing({ ...editing, proto: e.target.value })}>
                {PROTOS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label>Действие
              <select value={editing.action} onChange={(e) => setEditing({ ...editing, action: e.target.value })}>
                {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
            {editing.action === "jump" && (
              <label>Перейти в цепочку
                <select value={editing.jumpTo} onChange={(e) => setEditing({ ...editing, jumpTo: e.target.value })}>
                  <option value="">— выберите —</option>
                  {chains.filter((_, i) => i !== active).map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                </select>
              </label>
            )}
            <label>Порты источника
              <input value={editing.srcPorts} onChange={(e) => setEditing({ ...editing, srcPorts: e.target.value })} placeholder="1024-2048" />
            </label>
            <label>Порты получателя
              <input value={editing.dstPorts} onChange={(e) => setEditing({ ...editing, dstPorts: e.target.value })} placeholder="80,443" />
            </label>
            <label className="modal-check">
              <input type="checkbox" checked={editing.mirror} onChange={(e) => setEditing({ ...editing, mirror: e.target.checked })} />
              Зеркало
            </label>
            {hints.map((h) => <p className="cell-hint" key={h}>{h}</p>)}
          </div>
        )}
      </Modal>
    </main>
  );
}

const splitPorts = (spec: string) => spec.split(",").map((p) => p.trim()).filter(Boolean);

// Та же последовательность, что в легаси: имя, уникальность в цепочке,
// наличие концов, порты только для tcp/udp, корректность спецификации,
// цель jump. Возвращает все подсказки сразу — источник и получатель
// показываются вместе, а не по одному за раз.
function ruleHint(draft: RuleDraft, chain: ChainDoc | undefined): string[] {
  const hints: string[] = [];
  if (!draft.name.trim()) hints.push("Имя обязательно");
  else if (chain && chain.rules.some((r, i) => i !== draft.index && r.name === draft.name.trim())) {
    hints.push("Имя уже используется");
  }
  if (!draft.src.length) hints.push("Нужен хотя бы один источник");
  if (!draft.dst.length) hints.push("Нужен хотя бы один получатель");
  const hasPorts = draft.srcPorts.trim() || draft.dstPorts.trim();
  if (hasPorts && draft.proto !== "tcp" && draft.proto !== "udp") {
    hints.push("Порты допустимы только для tcp и udp");
  } else if (!validPortSpec(draft.srcPorts) || !validPortSpec(draft.dstPorts)) {
    hints.push("Порты: 1..65535 или диапазон from-to");
  }
  if (draft.action === "jump") {
    if (!draft.jumpTo) hints.push("Укажите цепочку для jump");
    else if (chain && draft.jumpTo === chain.name) hints.push("Цепочка не может переходить в себя");
  }
  return hints;
}
