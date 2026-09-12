import { createContext, useContext } from "react";

// Колбэки рёбер (изменение точек изгиба) идут через контекст: data у
// RF-объектов сериализуемые, функции в них класть нельзя. undefined —
// ребро вне редактируемой канвы: интерактивность отключена.
export type EdgeActions = {
  changeWaypoints: (edgeId: string, waypoints: Array<{ x: number; y: number }>) => void;
};

export const EdgeActionsContext = createContext<EdgeActions | undefined>(undefined);

export const useEdgeActions = () => useContext(EdgeActionsContext);
