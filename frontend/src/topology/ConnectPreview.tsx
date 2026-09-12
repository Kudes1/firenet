import { useContext } from "react";
import { ViewportContext } from "./viewport";

type Props = {
  // Оба конца — координаты сцены: центр первого выбранного объекта и курсор.
  from: { x: number; y: number };
  to: { x: number; y: number };
};

// Пунктирная линия-превью connect-инструмента (легаси previewWire): от
// центра ожидающего объекта к курсору. Оверлей лежит поверх канвы в её
// системе координат — transform камеры тот же, что у узлов, поэтому линия
// едет вместе с сеткой при панорамировании и зуме.
export function ConnectPreview({ from, to }: Props) {
  const [tx, ty, zoom] = useContext(ViewportContext);
  return (
    <svg className="connect-preview" data-testid="connect-preview" aria-hidden>
      <g transform={`translate(${tx} ${ty}) scale(${zoom})`}>
        <path d={`M ${from.x} ${from.y} L ${to.x} ${to.y}`} />
      </g>
    </svg>
  );
}
