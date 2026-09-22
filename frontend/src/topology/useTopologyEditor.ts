import { useCallback, useEffect, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useTopologyOperations, projectKeys } from "../api/queries";
import type { DeviceDoc, EditorSnapshot, LayoutDoc, LayoutPoint, LinkDoc, LinkFilterDoc, NetworkDoc, TopologyDoc, TopologyOperation } from "../api/types";
import { layoutLinkKey } from "../lib/links";
import { useDraft } from "../draft/DraftContext";
import { notify } from "../components/notify";
import { defaultPoint, parseEdgeId } from "./scene";

export type SyncStatus = "saved" | "dirty" | "saving" | "error";

const FLUSH_DELAY_MS = 400;

type FlushMode = "debounced" | "immediate";
type SendOperations = (operations: TopologyOperation[]) => Promise<EditorSnapshot>;

type EditorChannel = {
  queryClient: QueryClient;
  scope: string;
  queue: TopologyOperation[];
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
  inFlightOperations: TopologyOperation[];
  nextFlushMode: FlushMode;
  status: SyncStatus;
  listeners: Set<(status: SyncStatus) => void>;
  send: SendOperations | null;
};

const channels = new WeakMap<QueryClient, Map<string, EditorChannel>>();

function getEditorChannel(queryClient: QueryClient, scope: string): EditorChannel {
  let byScope = channels.get(queryClient);
  if (!byScope) {
    byScope = new Map();
    channels.set(queryClient, byScope);
  }
  let channel = byScope.get(scope);
  if (!channel) {
    channel = {
      queryClient,
      scope,
      queue: [],
      timer: null,
      inFlight: null,
      inFlightOperations: [],
      nextFlushMode: "debounced",
      status: "saved",
      listeners: new Set(),
      send: null,
    };
    byScope.set(scope, channel);
  }
  return channel;
}

function setChannelStatus(channel: EditorChannel, status: SyncStatus) {
  channel.status = status;
  channel.listeners.forEach((listener) => listener(status));
}

type OptimisticNode =
  | { kind: "device"; node: DeviceDoc }
  | { kind: "network"; node: NetworkDoc };

const emptyTopology: TopologyDoc = { devices: null, links: null, networks: null, sets: null, unions: null };

function updateOptimisticTopology(
  queryClient: QueryClient,
  scope: string,
  update: (topology: TopologyDoc) => TopologyDoc,
) {
  const key = projectKeys.resource(scope, "topology");
  void queryClient.cancelQueries({ queryKey: key }, { revert: false });
  const topology = queryClient.getQueryData<TopologyDoc>(key) ?? emptyTopology;
  queryClient.setQueryData<TopologyDoc>(key, update(topology));
}

function updateOptimisticLayout(
  queryClient: QueryClient,
  scope: string,
  update: (layout: LayoutDoc) => LayoutDoc,
) {
  const key = projectKeys.resource(scope, "layout");
  void queryClient.cancelQueries({ queryKey: key }, { revert: false });
  const layout = queryClient.getQueryData<LayoutDoc>(key) ?? {};
  queryClient.setQueryData<LayoutDoc>(key, update(layout));
}

function addOptimisticLink(queryClient: QueryClient, scope: string, link: LinkDoc) {
  updateOptimisticTopology(queryClient, scope, (topology) => ({
    ...topology,
    links: [...(topology.links ?? []), link],
  }));
}

function addOptimisticAttachment(queryClient: QueryClient, scope: string, networkName: string, attach: { device: string }) {
  updateOptimisticTopology(queryClient, scope, (topology) => ({
    ...topology,
    networks: (topology.networks ?? []).map((network) => {
      if (network.name !== networkName) return network;
      const attachments = network.attach ?? [];
      return attachments.some((item) => item.device === attach.device)
        ? network
        : { ...network, attach: [...attachments, attach] };
    }),
  }));
}

function sameLink(a: string, b: string, link: LinkDoc) {
  return layoutLinkKey(a, b) === layoutLinkKey(link.a.device, link.b.device);
}

function updateOptimisticLink(
  queryClient: QueryClient,
  scope: string,
  a: string,
  b: string,
  update: (link: LinkDoc) => LinkDoc,
) {
  updateOptimisticTopology(queryClient, scope, (topology) => {
    const links = topology.links ? [...topology.links] : topology.links;
    const index = links?.findIndex((link) => sameLink(a, b, link)) ?? -1;
    if (index >= 0 && links) links[index] = update(links[index]);
    return { ...topology, links };
  });
}

function removeOptimisticLink(queryClient: QueryClient, scope: string, link: LinkDoc) {
  updateOptimisticTopology(queryClient, scope, (topology) => {
    const links = topology.links ? [...topology.links] : topology.links;
    const index = links?.findIndex((current) => sameLink(link.a.device, link.b.device, current)) ?? -1;
    if (index >= 0 && links) links.splice(index, 1);
    return { ...topology, links };
  });
  updateOptimisticLayout(queryClient, scope, (layout) => {
    if (!layout.links) return layout;
    const links = { ...layout.links };
    delete links[layoutLinkKey(link.a.device, link.b.device)];
    return { ...layout, links };
  });
}

function removeOptimisticAttachment(queryClient: QueryClient, scope: string, networkName: string, device: string) {
  updateOptimisticTopology(queryClient, scope, (topology) => ({
    ...topology,
    networks: topology.networks?.map((network) => network.name !== networkName
      ? network
      : { ...network, attach: network.attach?.filter((item) => item.device !== device) ?? network.attach }) ?? topology.networks,
  }));
}

function setOptimisticLinkFilter(
  queryClient: QueryClient,
  scope: string,
  a: string,
  b: string,
  filter: LinkFilterDoc | undefined,
) {
  updateOptimisticLink(queryClient, scope, a, b, (link) => {
    if (filter) return { ...link, filter };
    const { filter: _filter, ...withoutFilter } = link;
    return withoutFilter;
  });
}

function addOptimisticNode(queryClient: QueryClient, scope: string, value: OptimisticNode, position: LayoutPoint) {
  const topologyKey = projectKeys.resource(scope, "topology");
  void queryClient.cancelQueries({ queryKey: topologyKey }, { revert: false });
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

  if (value.kind === "device") {
    setOptimisticDevicePosition(queryClient, scope, value.node.name, position);
  } else {
    setOptimisticNetworkPosition(queryClient, scope, value.node.name, position);
  }
}

function setOptimisticDevicePosition(queryClient: QueryClient, scope: string, name: string, position: LayoutPoint) {
  updateOptimisticLayout(queryClient, scope, (layout) => ({
    ...layout,
    devices: { ...(layout.devices ?? {}), [name]: position },
  }));
}

function setOptimisticNetworkPosition(queryClient: QueryClient, scope: string, name: string, position: LayoutPoint) {
  updateOptimisticLayout(queryClient, scope, (layout) => ({
    ...layout,
    networks: { ...(layout.networks ?? {}), [name]: position },
  }));
}

function setOptimisticCamera(queryClient: QueryClient, scope: string, camera: NonNullable<LayoutDoc["camera"]>) {
  updateOptimisticLayout(queryClient, scope, (layout) => ({ ...layout, camera }));
}

function setOptimisticLinkWaypoints(
  queryClient: QueryClient,
  scope: string,
  link: LinkDoc,
  waypoints: LayoutPoint[][],
) {
  updateOptimisticLayout(queryClient, scope, (layout) => ({
    ...layout,
    links: { ...layout.links, [layoutLinkKey(link.a.device, link.b.device)]: waypoints },
  }));
}

function renameLayoutEntity(
  layout: LayoutDoc,
  kind: "device" | "network",
  from: string,
  to: string,
  links: LinkDoc[] | null | undefined,
): LayoutDoc {
  const positions = kind === "device" ? layout.devices : layout.networks;
  const nextPositions = positions ? { ...positions } : positions;
  if (nextPositions && from in nextPositions) {
    nextPositions[to] = nextPositions[from];
    delete nextPositions[from];
  }

  const nextLinks = layout.links ? { ...layout.links } : layout.links;
  if (nextLinks && links) {
    for (const link of links) {
      if (kind !== "device" || (link.a.device !== from && link.b.device !== from)) continue;
      const oldKey = layoutLinkKey(link.a.device, link.b.device);
      const a = link.a.device === from ? to : link.a.device;
      const b = link.b.device === from ? to : link.b.device;
      const newKey = layoutLinkKey(a, b);
      if (oldKey !== newKey && oldKey in nextLinks) {
        nextLinks[newKey] = nextLinks[oldKey];
        delete nextLinks[oldKey];
      }
    }
  }

  return kind === "device"
    ? { ...layout, devices: nextPositions, links: nextLinks }
    : { ...layout, networks: nextPositions };
}

function updateOptimisticDevice(
  queryClient: QueryClient,
  scope: string,
  deviceName: string,
  device: DeviceDoc,
) {
  const topologyKey = projectKeys.resource(scope, "topology");
  const current = queryClient.getQueryData<TopologyDoc>(topologyKey);
  if (!current?.devices?.some((item) => item.name === deviceName)) return;
  const renamed = device.name !== deviceName;

  updateOptimisticTopology(queryClient, scope, (topology) => ({
    ...topology,
    devices: topology.devices?.map((item) => item.name === deviceName ? device : item) ?? topology.devices,
    ...(renamed ? {
      links: topology.links?.map((link) => ({
        ...link,
        a: link.a.device === deviceName ? { ...link.a, device: device.name } : link.a,
        b: link.b.device === deviceName ? { ...link.b, device: device.name } : link.b,
      })) ?? topology.links,
      networks: topology.networks?.map((network) => ({
        ...network,
        attach: network.attach?.map((attach) => attach.device === deviceName
          ? { ...attach, device: device.name }
          : attach),
      })) ?? topology.networks,
      unions: topology.unions?.map((union) => ({
        ...union,
        devices: union.devices?.map((name) => name === deviceName ? device.name : name),
      })) ?? topology.unions,
    } : {}),
  }));

  if (renamed) {
    updateOptimisticLayout(queryClient, scope, (layout) => renameLayoutEntity(
      layout, "device", deviceName, device.name, current.links,
    ));
  }
}

function updateOptimisticNetwork(
  queryClient: QueryClient,
  scope: string,
  networkName: string,
  network: NetworkDoc,
) {
  const topologyKey = projectKeys.resource(scope, "topology");
  const current = queryClient.getQueryData<TopologyDoc>(topologyKey);
  const previous = current?.networks?.find((item) => item.name === networkName);
  if (!previous) return;
  const renamed = network.name !== networkName;
  const nextNetwork: NetworkDoc = { ...network, attach: previous.attach };

  updateOptimisticTopology(queryClient, scope, (topology) => ({
    ...topology,
    networks: topology.networks?.map((item) => item.name === networkName ? nextNetwork : item) ?? topology.networks,
    ...(renamed ? {
      links: topology.links?.map((link) => link.filter ? {
        ...link,
        filter: {
          ...link.filter,
          aExports: link.filter.aExports.map((name) => name === networkName ? network.name : name),
          bExports: link.filter.bExports.map((name) => name === networkName ? network.name : name),
        },
      } : link) ?? topology.links,
      unions: topology.unions?.map((union) => ({
        ...union,
        networks: union.networks?.map((name) => name === networkName ? network.name : name),
      })) ?? topology.unions,
    } : {}),
  }));

  if (renamed) {
    updateOptimisticLayout(queryClient, scope, (layout) => renameLayoutEntity(
      layout, "network", networkName, network.name, current?.links,
    ));
  }
}

function deleteOptimisticDevice(queryClient: QueryClient, scope: string, deviceName: string) {
  const topologyKey = projectKeys.resource(scope, "topology");
  const current = queryClient.getQueryData<TopologyDoc>(topologyKey);
  if (!current?.devices?.some((device) => device.name === deviceName)) return;
  const deletedLinks = current.links?.filter((link) => link.a.device === deviceName || link.b.device === deviceName);

  updateOptimisticTopology(queryClient, scope, (topology) => ({
    ...topology,
    devices: topology.devices?.filter((device) => device.name !== deviceName) ?? topology.devices,
    links: topology.links?.filter((link) => link.a.device !== deviceName && link.b.device !== deviceName) ?? topology.links,
    networks: topology.networks?.map((network) => network.attach?.some((attach) => attach.device === deviceName)
      ? { ...network, attach: network.attach.filter((attach) => attach.device !== deviceName) }
      : network) ?? topology.networks,
    unions: topology.unions?.map((union) => union.devices?.includes(deviceName)
      ? { ...union, devices: union.devices.filter((name) => name !== deviceName) }
      : union) ?? topology.unions,
  }));
  updateOptimisticLayout(queryClient, scope, (layout) => {
    const devices = layout.devices ? { ...layout.devices } : layout.devices;
    if (devices) delete devices[deviceName];
    const links = layout.links ? { ...layout.links } : layout.links;
    deletedLinks?.forEach((link) => { if (links) delete links[layoutLinkKey(link.a.device, link.b.device)]; });
    return { ...layout, devices, links };
  });
}

function deleteOptimisticNetwork(queryClient: QueryClient, scope: string, networkName: string) {
  const topologyKey = projectKeys.resource(scope, "topology");
  const current = queryClient.getQueryData<TopologyDoc>(topologyKey);
  if (!current?.networks?.some((network) => network.name === networkName)) return;

  updateOptimisticTopology(queryClient, scope, (topology) => ({
    ...topology,
    networks: topology.networks?.filter((network) => network.name !== networkName) ?? topology.networks,
    links: topology.links?.map((link) => link.filter ? {
      ...link,
      filter: {
        ...link.filter,
        aExports: link.filter.aExports.filter((name) => name !== networkName),
        bExports: link.filter.bExports.filter((name) => name !== networkName),
      },
    } : link) ?? topology.links,
    unions: topology.unions?.map((union) => union.networks?.includes(networkName)
      ? { ...union, networks: union.networks.filter((name) => name !== networkName) }
      : union) ?? topology.unions,
  }));
  updateOptimisticLayout(queryClient, scope, (layout) => {
    const networks = layout.networks ? { ...layout.networks } : layout.networks;
    if (networks) delete networks[networkName];
    return { ...layout, networks };
  });
}

function updateOptimisticUnionMember(
  queryClient: QueryClient,
  scope: string,
  unionName: string,
  nodeKind: "device" | "network",
  memberName: string,
  add: boolean,
) {
  updateOptimisticTopology(queryClient, scope, (topology) => ({
    ...topology,
    unions: topology.unions?.map((union) => {
      if (union.name !== unionName) return union;
      if (nodeKind === "device") {
        const devices = union.devices ?? [];
        if (add) return devices.includes(memberName) ? union : { ...union, devices: [...devices, memberName] };
        return devices.includes(memberName)
          ? { ...union, devices: devices.filter((name) => name !== memberName) }
          : union;
      }
      const networks = union.networks ?? [];
      if (add) return networks.includes(memberName) ? union : { ...union, networks: [...networks, memberName] };
      return networks.includes(memberName)
        ? { ...union, networks: networks.filter((name) => name !== memberName) }
        : union;
    }) ?? topology.unions,
  }));
}

function applyOptimisticOperation(queryClient: QueryClient, scope: string, operation: TopologyOperation) {
  if (operation.kind === "update-device" && operation.deviceName && operation.device) {
    updateOptimisticDevice(queryClient, scope, operation.deviceName, operation.device);
  } else if (operation.kind === "update-network" && operation.networkName && operation.network) {
    updateOptimisticNetwork(queryClient, scope, operation.networkName, operation.network);
  } else if (operation.kind === "delete-device" && operation.deviceName) {
    deleteOptimisticDevice(queryClient, scope, operation.deviceName);
  } else if (operation.kind === "delete-network" && operation.networkName) {
    deleteOptimisticNetwork(queryClient, scope, operation.networkName);
  } else if (operation.kind === "union-add-device" && operation.unionName && operation.deviceName) {
    updateOptimisticUnionMember(queryClient, scope, operation.unionName, "device", operation.deviceName, true);
  } else if (operation.kind === "union-remove-device" && operation.unionName && operation.deviceName) {
    updateOptimisticUnionMember(queryClient, scope, operation.unionName, "device", operation.deviceName, false);
  } else if (operation.kind === "union-add-network" && operation.unionName && operation.networkName) {
    updateOptimisticUnionMember(queryClient, scope, operation.unionName, "network", operation.networkName, true);
  } else if (operation.kind === "union-remove-network" && operation.unionName && operation.networkName) {
    updateOptimisticUnionMember(queryClient, scope, operation.unionName, "network", operation.networkName, false);
  }
}

function reapplyQueuedOptimisticOperations(queryClient: QueryClient, scope: string, operations: TopologyOperation[]) {
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
    } else if (operation.kind === "create-link" && operation.link) {
      addOptimisticLink(queryClient, scope, operation.link);
    } else if (operation.kind === "delete-link" && operation.link) {
      removeOptimisticLink(queryClient, scope, operation.link);
    } else if (operation.kind === "set-link-filter" && operation.link && operation.filter) {
      setOptimisticLinkFilter(queryClient, scope, operation.link.a.device, operation.link.b.device, operation.filter);
    } else if (operation.kind === "clear-link-filter" && operation.link) {
      setOptimisticLinkFilter(queryClient, scope, operation.link.a.device, operation.link.b.device, undefined);
    } else if (operation.kind === "attach-network" && operation.networkName && operation.attach) {
      addOptimisticAttachment(queryClient, scope, operation.networkName, operation.attach);
    } else if (operation.kind === "detach-network" && operation.networkName && operation.attach) {
      removeOptimisticAttachment(queryClient, scope, operation.networkName, operation.attach.device);
    } else if (operation.kind === "set-link-waypoints" && operation.link && operation.waypoints) {
      setOptimisticLinkWaypoints(queryClient, scope, operation.link, operation.waypoints);
    } else if (operation.kind === "set-device-position" && operation.deviceName && operation.position) {
      setOptimisticDevicePosition(queryClient, scope, operation.deviceName, operation.position);
    } else if (operation.kind === "set-network-position" && operation.networkName && operation.position) {
      setOptimisticNetworkPosition(queryClient, scope, operation.networkName, operation.position);
    } else if (operation.kind === "set-camera" && operation.camera) {
      setOptimisticCamera(queryClient, scope, operation.camera);
    } else if (
      operation.kind === "update-device" || operation.kind === "update-network"
      || operation.kind === "delete-device" || operation.kind === "delete-network"
      || operation.kind === "union-add-device" || operation.kind === "union-remove-device"
      || operation.kind === "union-add-network" || operation.kind === "union-remove-network"
    ) {
      applyOptimisticOperation(queryClient, scope, operation);
    }
  }
}

function removeFailedOptimisticOperations(queryClient: QueryClient, scope: string, operations: TopologyOperation[]) {
  const devices = new Set<string>();
  const networks = new Set<string>();
  const links = new Set<string>();
  const attachments = new Set<string>();
  for (const operation of operations) {
    if (operation.kind === "create-device" && operation.device) devices.add(operation.device.name);
    if (operation.kind === "create-network" && operation.network) networks.add(operation.network.name);
    if (operation.kind === "create-link" && operation.link) {
      links.add(layoutLinkKey(operation.link.a.device, operation.link.b.device));
    }
    if (operation.kind === "attach-network" && operation.networkName && operation.attach) {
      attachments.add(`${operation.networkName}\u0000${operation.attach.device}`);
    }
  }
  if (devices.size || networks.size || links.size || attachments.size) {
    const topologyKey = projectKeys.resource(scope, "topology");
    const topology = queryClient.getQueryData<TopologyDoc>(topologyKey);
    if (topology) {
      queryClient.setQueryData<TopologyDoc>(topologyKey, {
        ...topology,
        devices: topology.devices?.filter((device) => !devices.has(device.name)) ?? topology.devices,
        links: topology.links?.filter((link) =>
          !links.has(layoutLinkKey(link.a.device, link.b.device))) ?? topology.links,
        networks: topology.networks
          ?.filter((network) => !networks.has(network.name))
          .map((network) => ({
            ...network,
            attach: network.attach?.filter((attach) =>
              !attachments.has(`${network.name}\u0000${attach.device}`)) ?? network.attach,
          })) ?? topology.networks,
      });
    }
    const layoutKey = projectKeys.resource(scope, "layout");
    const layout = queryClient.getQueryData<LayoutDoc>(layoutKey);
    if (layout) {
      const nextDevices = { ...(layout.devices ?? {}) };
      const nextNetworks = { ...(layout.networks ?? {}) };
      devices.forEach((name) => delete nextDevices[name]);
      networks.forEach((name) => delete nextNetworks[name]);
      const nextLinks = { ...(layout.links ?? {}) };
      links.forEach((key) => delete nextLinks[key]);
      queryClient.setQueryData<LayoutDoc>(layoutKey, {
        ...layout,
        devices: nextDevices,
        networks: nextNetworks,
        links: nextLinks,
      });
    }
  }
}

async function flushEditorChannel(channel: EditorChannel, isReadOnly: boolean): Promise<void> {
  if (channel.inFlight) return channel.inFlight;
  if (channel.timer) {
    clearTimeout(channel.timer);
    channel.timer = null;
  }
  if (!channel.queue.length) return;
  if (isReadOnly) {
    channel.queue = [];
    setChannelStatus(channel, "saved");
    return;
  }
  const send = channel.send;
  if (!send) return;
  const batch = channel.queue;
  channel.queue = [];
  channel.nextFlushMode = "debounced";
  channel.inFlightOperations = batch;
  setChannelStatus(channel, "saving");
  const request = (async () => {
    try {
      await send(batch);
      reapplyQueuedOptimisticOperations(channel.queryClient, channel.scope, channel.queue);
      setChannelStatus(channel, channel.queue.length ? "dirty" : "saved");
    } catch (error) {
      // После провала записи (409 CAS, 422) канва может содержать optimistic-
      // изменения — удаляем объекты этой batch и перечитываем topology и
      // layout с сервера.
      removeFailedOptimisticOperations(channel.queryClient, channel.scope, batch);
      await Promise.all([
        channel.queryClient.invalidateQueries({ queryKey: projectKeys.resource(channel.scope, "topology") }),
        channel.queryClient.invalidateQueries({ queryKey: projectKeys.resource(channel.scope, "layout") }),
      ]);
      reapplyQueuedOptimisticOperations(channel.queryClient, channel.scope, channel.queue);
      setChannelStatus(channel, "error");
      notify((error as Error).message);
    } finally {
      channel.inFlightOperations = [];
      channel.inFlight = null;
      if (channel.queue.length) {
        if (channel.nextFlushMode === "immediate") {
          // Сначала отдаём вызывающему кэш с повторно наложенным optimistic-
          // состоянием, затем запускаем следующий запрос в том же event loop.
          channel.timer = setTimeout(() => void flushEditorChannel(channel, isReadOnly), 0);
        } else {
          channel.timer = setTimeout(() => void flushEditorChannel(channel, isReadOnly), FLUSH_DELAY_MS);
        }
      }
    }
  })();
  channel.inFlight = request;
  await request;
}

async function waitForEditorIdle(channel: EditorChannel, isReadOnly: boolean): Promise<void> {
  while (channel.queue.length || channel.inFlight || channel.timer) {
    if (!channel.send) return;
    await flushEditorChannel(channel, isReadOnly);
  }
}

// Очередь операций редактора: дискретные действия отправляются сразу,
// непрерывные изменения (например, drag) собираются в батч с дебаунсом.
// Статус нужен для индикатора «сохранено/изменено» в тулбаре.
export function useTopologyEditor() {
  const { isReadOnly, scope } = useDraft();
  const ops = useTopologyOperations();
  const queryClient = useQueryClient();
  const channel = getEditorChannel(queryClient, scope);
  channel.send = ops.mutateAsync;
  const [status, setStatus] = useState<SyncStatus>(() => channel.status);

  useEffect(() => {
    channel.listeners.add(setStatus);
    setStatus(channel.status);
    return () => {
      channel.listeners.delete(setStatus);
      if (!channel.listeners.size && !channel.queue.length && !channel.inFlight && !channel.timer) {
        channels.get(queryClient)?.delete(scope);
      }
    };
  }, [channel, queryClient, scope]);

  const flush = useCallback(() => flushEditorChannel(channel, isReadOnly), [channel, isReadOnly]);

  const enqueue = useCallback((operation: TopologyOperation, mode: "debounced" | "immediate" = "debounced") => {
    if (isReadOnly) {
      notify("Только чтение — откройте черновик, чтобы редактировать");
      return;
    }
    applyOptimisticOperation(queryClient, scope, operation);
    channel.queue.push(operation);
    setChannelStatus(channel, "dirty");
    if (mode === "immediate") channel.nextFlushMode = "immediate";
    if (channel.inFlight) return;
    if (channel.timer) {
      clearTimeout(channel.timer);
      channel.timer = null;
    }
    if (mode === "immediate") void flushEditorChannel(channel, isReadOnly);
    else channel.timer = setTimeout(() => void flushEditorChannel(channel, isReadOnly), FLUSH_DELAY_MS);
  }, [channel, isReadOnly]);

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
    const link: LinkDoc = { a: { device: a }, b: { device: b } };
    if (!isReadOnly) addOptimisticLink(queryClient, scope, link);
    enqueue({ kind: "create-link", link }, "immediate");
  }, [enqueue, isReadOnly, queryClient, scope]);

  // attachNetwork — привязка устройства к сети (второй исход connect-
  // инструмента). Пара network+device приходит уже разобранной (lib/connect).
  const attachNetwork = useCallback((networkName: string, device: string) => {
    const attach = { device };
    if (!isReadOnly) addOptimisticAttachment(queryClient, scope, networkName, attach);
    enqueue({ kind: "attach-network", networkName, attach }, "immediate");
  }, [enqueue, isReadOnly, queryClient, scope]);

  const setLinkFilter = useCallback(async (a: string, b: string, filter?: LinkFilterDoc) => {
    if (!isReadOnly) setOptimisticLinkFilter(queryClient, scope, a, b, filter);
    const link: LinkDoc = { a: { device: a }, b: { device: b } };
    enqueue(filter
      ? { kind: "set-link-filter", link, filter }
      : { kind: "clear-link-filter", link }, "immediate");
    await waitForEditorIdle(channel, isReadOnly);
  }, [channel, enqueue, isReadOnly, queryClient, scope]);

  const isLinkPending = useCallback((a: string, b: string) => {
    const key = layoutLinkKey(a, b);
    return [...channel.inFlightOperations, ...channel.queue].some((operation) =>
      operation.kind === "create-link" && !!operation.link
      && layoutLinkKey(operation.link.a.device, operation.link.b.device) === key,
    );
  }, [channel]);

  // deleteLink/detachNetwork — операции контекстного меню по связи/привязке.
  // Пара устройств нормализуется: бэкенд ищет связь по канонической паре.
  const deleteLink = useCallback((a: string, b: string) => {
    const link: LinkDoc = { a: { device: a }, b: { device: b } };
    if (!isReadOnly) removeOptimisticLink(queryClient, scope, link);
    enqueue({ kind: "delete-link", link }, "immediate");
  }, [enqueue, isReadOnly, queryClient, scope]);

  const detachNetwork = useCallback((networkName: string, device: string) => {
    if (!isReadOnly) removeOptimisticAttachment(queryClient, scope, networkName, device);
    enqueue({ kind: "detach-network", networkName, attach: { device } }, "immediate");
  }, [enqueue, isReadOnly, queryClient, scope]);

  const removeSelected = useCallback((selection: string[]) => {
    const selectedDevices = new Set<string>();
    const selectedNetworks = new Set<string>();
    for (const id of selection) {
      const [kind, ...rest] = id.split(":");
      const name = rest.join(":");
      if (kind === "device") selectedDevices.add(name);
      if (kind === "network") selectedNetworks.add(name);
    }
    for (const id of selection) {
      const [kind, ...rest] = id.split(":");
      const name = rest.join(":");
      if (kind === "device") enqueue({ kind: "delete-device", deviceName: name });
      else if (kind === "network") enqueue({ kind: "delete-network", networkName: name });
      else {
        const parsed = parseEdgeId(id);
        if (parsed?.kind === "link" && !selectedDevices.has(parsed.a) && !selectedDevices.has(parsed.b)) {
          deleteLink(parsed.a, parsed.b);
        } else if (
          parsed?.kind === "attach"
          && !selectedNetworks.has(parsed.network)
          && !selectedDevices.has(parsed.device)
        ) {
          detachNetwork(parsed.network, parsed.device);
        }
      }
    }
  }, [deleteLink, detachNetwork, enqueue]);

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
    updateOptimisticLayout(queryClient, scope, (layout) => ({
      ...layout,
      links: { ...layout.links, [key]: all },
    }));
    enqueue({ kind: "set-link-waypoints", link: { a: { device: a }, b: { device: b } }, waypoints: all });
  }, [enqueue, queryClient, scope]);

  // Батч операций из форм редактирования (update-device + перенос union).
  const enqueueAll = useCallback((operations: TopologyOperation[]) => {
    operations.forEach((operation) => enqueue(operation));
  }, [enqueue]);

  return {
    status, flush, moveDevice, moveNetwork, createDevice, createNetwork,
    createLink, attachNetwork, setLinkFilter, isLinkPending, removeSelected, setUnion, enqueueAll, deleteLink, detachNetwork,
    setCamera, setLinkWaypoints, nextDevicePoint: (index: number) => defaultPoint("device", index),
  };
}
