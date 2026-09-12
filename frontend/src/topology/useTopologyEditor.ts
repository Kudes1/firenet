import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useTopologyOperations, projectKeys } from "../api/queries";
import type { DeviceDoc, LayoutDoc, LayoutPoint, NetworkDoc, TopologyDoc, TopologyOperation } from "../api/types";
import { layoutLinkKey } from "../lib/links";
import { useDraft } from "../draft/DraftContext";
import { notify } from "../components/notify";
import { defaultPoint } from "./scene";

export type SyncStatus = "saved" | "dirty" | "saving" | "error";

const FLUSH_DELAY_MS = 400;

type OptimisticNode =
  | { kind: "device"; node: DeviceDoc }
  | { kind: "network"; node: NetworkDoc };

function addOptimisticNode(queryClient: QueryClient, scope: string, value: OptimisticNode, position: LayoutPoint) {
  const topologyKey = projectKeys.resource(scope, "topology");
  void queryClient.cancelQueries({ queryKey: topologyKey });
  const topology = queryClient.getQueryData<TopologyDoc>(topologyKey) ?? {
    devices: null, links: null, networks: null, sets: null, unions: null,
  };
  if (value.kind === "device") {
    queryClient.setQueryData<TopologyDoc>(topologyKey, {
      ...topology,
      devices: topology.devices?.some((device) => device.name === value.node.name)
        ? topology.devices
        : [...(topology.devices ?? []), value.node],
    });
  } else {
    queryClient.setQueryData<TopologyDoc>(topologyKey, {
      ...topology,
      networks: topology.networks?.some((network) => network.name === value.node.name)
        ? topology.networks
        : [...(topology.networks ?? []), value.node],
    });
  }

  const layoutKey = projectKeys.resource(scope, "layout");
  void queryClient.cancelQueries({ queryKey: layoutKey });
  const layout = queryClient.getQueryData<LayoutDoc>(layoutKey) ?? {};
  if (value.kind === "device") {
    queryClient.setQueryData<LayoutDoc>(layoutKey, {
      ...layout,
      devices: { ...(layout.devices ?? {}), [value.node.name]: position },
    });
  } else {
    queryClient.setQueryData<LayoutDoc>(layoutKey, {
      ...layout,
      networks: { ...(layout.networks ?? {}), [value.node.name]: position },
    });
  }
}

function reapplyQueuedCreates(queryClient: QueryClient, scope: string, operations: TopologyOperation[]) {
  const positions = new Map<string, LayoutPoint>();
  for (const operation of operations) {
    if (operation.kind === "set-device-position" && operation.deviceName && operation.position) {
      positions.set(`device:${operation.deviceName}`, operation.position);
    } else if (operation.kind === "set-network-position" && operation.networkName && operation.position) {
      positions.set(`network:${operation.networkName}`, operation.position);
    }
  }
  for (const operation of operations) {
    if (operation.kind === "create-device" && operation.device) {
      const position = positions.get(`device:${operation.device.name}`);
      if (position) addOptimisticNode(queryClient, scope, { kind: "device", node: operation.device }, position);
    } else if (operation.kind === "create-network" && operation.network) {
      const position = positions.get(`network:${operation.network.name}`);
      if (position) addOptimisticNode(queryClient, scope, { kind: "network", node: operation.network }, position);
    }
  }
}

function removeFailedCreates(queryClient: QueryClient, scope: string, operations: TopologyOperation[]) {
  const devices = new Set<string>();
  const networks = new Set<string>();
  for (const operation of operations) {
    if (operation.kind === "create-device" && operation.device) devices.add(operation.device.name);
    if (operation.kind === "create-network" && operation.network) networks.add(operation.network.name);
  }
  if (devices.size || networks.size) {
    const topologyKey = projectKeys.resource(scope, "topology");
    const topology = queryClient.getQueryData<TopologyDoc>(topologyKey);
    if (topology) {
      queryClient.setQueryData<TopologyDoc>(topologyKey, {
        ...topology,
        devices: topology.devices?.filter((device) => !devices.has(device.name)) ?? topology.devices,
        networks: topology.networks?.filter((network) => !networks.has(network.name)) ?? topology.networks,
      });
    }
    const layoutKey = projectKeys.resource(scope, "layout");
    const layout = queryClient.getQueryData<LayoutDoc>(layoutKey);
    if (layout) {
      const nextDevices = { ...(layout.devices ?? {}) };
      const nextNetworks = { ...(layout.networks ?? {}) };
      devices.forEach((name) => delete nextDevices[name]);
      networks.forEach((name) => delete nextNetworks[name]);
      queryClient.setQueryData<LayoutDoc>(layoutKey, {
        ...layout,
        devices: nextDevices,
        networks: nextNetworks,
      });
    }
  }
}

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
  const inFlight = useRef<Promise<void> | null>(null);
  const [status, setStatus] = useState<SyncStatus>("saved");

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (inFlight.current) return inFlight.current;
    if (!queue.current.length) return;
    if (isReadOnly) {
      queue.current = [];
      setStatus("saved");
      return;
    }
    const batch = queue.current;
    queue.current = [];
    setStatus("saving");
    const request = (async () => {
      try {
        await ops.mutateAsync(batch);
        reapplyQueuedCreates(queryClient, scope, queue.current);
        setStatus(queue.current.length ? "dirty" : "saved");
      } catch (error) {
        // После провала записи (409 CAS, 422) канва может содержать optimistic-
        // изменения — удаляем объекты этой batch и перечитываем topology и
        // layout с сервера.
        removeFailedCreates(queryClient, scope, batch);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: projectKeys.resource(scope, "topology") }),
          queryClient.invalidateQueries({ queryKey: projectKeys.resource(scope, "layout") }),
        ]);
        reapplyQueuedCreates(queryClient, scope, queue.current);
        setStatus("error");
        notify((error as Error).message);
      } finally {
        inFlight.current = null;
        if (queue.current.length) timer.current = setTimeout(() => void flush(), FLUSH_DELAY_MS);
      }
    })();
    inFlight.current = request;
    await request;
  }, [isReadOnly, ops, queryClient, scope]);

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
    if (!isReadOnly) addOptimisticNode(queryClient, scope, { kind: "device", node: device }, position);
    enqueue({ kind: "create-device", device });
    enqueue({ kind: "set-device-position", deviceName: device.name, position });
    return device;
  }, [enqueue, isReadOnly, queryClient, scope]);

  const createNetwork = useCallback((position: LayoutPoint, name?: string) => {
    const network: NetworkDoc = { name: name ?? `network-${Date.now().toString(36)}` };
    if (!isReadOnly) addOptimisticNode(queryClient, scope, { kind: "network", node: network }, position);
    enqueue({ kind: "create-network", network });
    enqueue({ kind: "set-network-position", networkName: network.name, position });
    return network;
  }, [enqueue, isReadOnly, queryClient, scope]);

  const createLink = useCallback((a: string, b: string) => {
    enqueue({ kind: "create-link", link: { a: { device: a }, b: { device: b } } });
  }, [enqueue]);

  // attachNetwork — привязка устройства к сети (второй исход connect-
  // инструмента). Пара network+device приходит уже разобранной (lib/connect).
  const attachNetwork = useCallback((networkName: string, device: string) => {
    enqueue({ kind: "attach-network", networkName, attach: { device } });
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

  // setLinkWaypoints заменяет точки изгиба одного дубликата связи (index —
  // позиция среди резервных связей пары). Бэкендовская set-link-waypoints
  // заменяет весь массив пары, поэтому из кэша layout берётся текущий состав
  // (точки соседних дубликатов) и отсылается целиком. Эхо-апдейт кэша до
  // flush: flush дебаунсится, и без него точка отрисовалась бы с опозданием
  // и пропадала при перерисовках.
  const setLinkWaypoints = useCallback((a: string, b: string, index: number, points: LayoutPoint[]) => {
    const key = layoutLinkKey(a, b);
    const doc = queryClient.getQueryData(projectKeys.resource(scope, "layout")) as LayoutDoc | undefined;
    const all = [...(doc?.links?.[key] ?? [])];
    while (all.length <= index) all.push([]);
    all[index] = points;
    queryClient.setQueryData(projectKeys.resource(scope, "layout"),
      { ...(doc ?? { devices: {}, networks: {} }), links: { ...doc?.links, [key]: all } });
    enqueue({ kind: "set-link-waypoints", link: { a: { device: a }, b: { device: b } }, waypoints: all });
  }, [enqueue, queryClient, scope]);

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
    createLink, attachNetwork, removeSelected, setUnion, enqueueAll, deleteLink, detachNetwork,
    setCamera, setLinkWaypoints, nextDevicePoint: (index: number) => defaultPoint("device", index),
  };
}
