import Combo from "./Combo";

type Props = {
  members: string[];
  // Подпись справа от имени: CIDR подсети и т.п.
  detailOf?: (name: string) => string;
  onRemove?: (name: string) => void;
  candidates?: string[];
  onAdd?: (name: string) => void;
  addPlaceholder?: string;
  readOnly?: boolean;
  empty?: string;
};

// Список участников с комбобоксом добавления: подсети сети, адреса набора,
// экспорты связи, эндпоинты правила. Одна разметка на все страницы.
export default function MemberList({
  members, detailOf, onRemove, candidates, onAdd, addPlaceholder, readOnly, empty,
}: Props) {
  return (
    <div className="member-list">
      {members.map((name) => (
        <div className="member-row" key={name}>
          <span className="owner-badge">{name}</span>
          {detailOf && <span className="hint">{detailOf(name)}</span>}
          {!readOnly && onRemove && (
            <button type="button" className="icon-btn delete" title="Убрать" onClick={() => onRemove(name)}>×</button>
          )}
        </div>
      ))}
      {members.length === 0 && <p className="hint member-empty">{empty ?? "Ничего не добавлено"}</p>}
      {!readOnly && onAdd && candidates && (
        <div className="member-add">
          <Combo items={candidates} placeholder={addPlaceholder} onPick={onAdd} />
        </div>
      )}
    </div>
  );
}
