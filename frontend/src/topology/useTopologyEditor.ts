import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTopologyOperations, projectKeys } from "../api/queries";
import type { DeviceDoc, LayoutPoint, NetworkDoc, TopologyDoc, TopologyOperation } from "../api/types";
import { useDraft } from "../draft/DraftContext";
import { notify } from "../components/notify";
import { defaultPoint } from "./scene";

export type SyncStatus = "saved" | "dirty" | "saving" | "error";

const FLUSH_DELAY_MS = 400;

// Очередь операций редактора: drag узла, создание устройства, связи и т.п.
// складываются в очередь и улетают одним запросом с дебаунсом — ровно та
// модель, что была в topology_sync.js. Статус нужен для индикатора
// «сохранено/изменено» в тулбаре.
export function useTopologyEditor() {
  const { isReadOnly, scope } = useDraft();
  const ops = useTopologyOperations();
  const queryClient = useQueryClient();
  const queue = useRef<TopologyOperation[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<SyncStatus>("saved");

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!queue.current.length) return;
    if (isReadOnly) {
      queue.current = [];
      setStatus("saved");
      return;
    }
    const batch = queue.current;
    queue.current = [];
    setStatus("saving");
    try {
      await ops.mutateAsync(batch);
      setStatus("saved");
    } catch (error) {
      // reconcile из легаси-TopologySync: после провала записи (409 CAS,
      // 422) канва больше не совпадает с сервером — перечитываем документ
      // (заодно обновляется CAS-ревизия) и отбрасываем очередь, иначе
      // каждая следующая операция тоже упадёт с устаревшей ревизией.
      setStatus("error");
      notify((error as Error).message);
    }
  }, [isReadOnly, ops]);

  const enqueue = useCallback((operation: TopologyOperation) => {
    if (isReadOnly) {
      notify("Только чтение — откройте черновик, чтобы редактировать");
      return;
    }
    queue.current.push(operation);
    setStatus("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), FLUSH_DELAY_MS);
  }, [isReadOnly, flush]);

  // Незакрытая очередь не должна пропадать при уходе со страницы.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const moveDevice = useCallback((name: string, position: LayoutPoint) => {
    enqueue({ kind: "set-device-position", deviceName: name, position });
  }, [enqueue]);

  const moveNetwork = useCallback((name: string, position: LayoutPoint) => {
    enqueue({ kind: "set-network-position", networkName: name, position });
  }, [enqueue]);

  const createDevice = useCallback((position: LayoutPoint, kind: DeviceDoc["kind"], name?: string) => {
    const device: DeviceDoc = { name: name ?? `device-${Date.now().toString(36)}`, kind };
    enqueue({ kind: "create-device", device });
    enqueue({ kind: "set-device-position", deviceName: device.name, position });
    return device;
  }, [enqueue]);

  const createNetwork = useCallback((position: LayoutPoint, name?: string) => {
    const network: NetworkDoc = { name: name ?? `network-${Date.now().toString(36)}` };
    enqueue({ kind: "create-network", network });
    enqueue({ kind: "set-network-position", networkName: network.name, position });
    return network;
  }, [enqueue]);

  const createLink = useCallback((a: string, b: string) => {
    enqueue({ kind: "create-link", link: { a: { device: a }, b: { device: b } } });
  }, [enqueue]);

  const removeSelected = useCallback((selection: string[]) => {
    for (const id of selection) {
      const [kind, name] = id.split(":");
      if (kind === "device") enqueue({ kind: "delete-device", deviceName: name });
      else if (kind === "network") enqueue({ kind: "delete-network", networkName: name });
    }
  }, [enqueue]);

  // setUnion перемещает объект в объединение targetName (или из всех
  // объединений при null) — паритет с легаси setUnion в topology.js.
  // Состав объединений читается из актуального кэша react-query: между
  // открытием меню и кликом документ мог обновиться (flush чужой очереди),
  // и имя объединения — единственная идентичность, переживающая это.
  const setUnion = useCallback((name: string, nodeKind: "device" | "network", target: string | null) => {
    const doc = queryClient.getQueryData(projectKeys.resource(scope, "topology")) as TopologyDoc | undefined;
    const unions = doc?.unions ?? [];
    const idField = nodeKind === "device" ? "deviceName" : "networkName";
    const removeKind = nodeKind === "device" ? "union-remove-device" : "union-remove-network";
    const addKind = nodeKind === "device" ? "union-add-device" : "union-add-network";
    const targetUnion = target ? unions.find((u) => u.name === target) : undefined;
    const alreadyInTarget = !!targetUnion && (targetUnion[nodeKind === "device" ? "devices" : "networks"] ?? []).includes(name);
    const removeFrom = unions
      .filter((u) => (u[nodeKind === "device" ? "devices" : "networks"] ?? []).includes(name) && (!targetUnion || u.name !== targetUnion.name))
      .map((u) => u.name);
    removeFrom.forEach((unionName) => enqueue({ kind: removeKind, unionName, [idField]: name }));
    if (targetUnion && !alreadyInTarget) enqueue({ kind: addKind, unionName: targetUnion.name, [idField]: name });
  }, [enqueue, queryClient, scope]);

  const setCamera = useCallback((camera: { x: number; y: number; zoom: number }) => {
    enqueue({ kind: "set-camera", camera: { x: camera.x, y: camera.y, z: camera.zoom } });
  }, [enqueue]);

  // Батч операций из форм редактирования (update-device + перенос union).
  const enqueueAll = useCallback((operations: TopologyOperation[]) => {
    operations.forEach(enqueue);
  }, [enqueue]);

  // deleteLink/detachNetwork — операции контекстного меню по связи/привязке.
  // Пара устройств нормализуется: бэкенд ищет связь по канонической паре.
  const deleteLink = useCallback((a: string, b: string) => {
    enqueue({ kind: "delete-link", link: { a: { device: a }, b: { device: b } } });
  }, [enqueue]);

  const detachNetwork = useCallback((networkName: string, device: string) => {
    enqueue({ kind: "detach-network", networkName, attach: { device } });
  }, [enqueue]);

  return {
    status, flush, moveDevice, moveNetwork, createDevice, createNetwork,
    createLink, removeSelected, setUnion, enqueueAll, deleteLink, detachNetwork,
    setCamera, nextDevicePoint: (index: number) => defaultPoint("device", index),
  };
}
