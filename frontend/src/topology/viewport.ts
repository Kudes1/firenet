import { createContext } from "react";

// Живой transform камеры React Flow [x, y, zoom]: обновляется при любом
// панорамировании/зуме. По умолчанию тождественный — оверлеи работают
// и вне канвы (тесты, страницы без TopologyCanvas).
export const ViewportContext = createContext<[number, number, number]>([0, 0, 1]);
