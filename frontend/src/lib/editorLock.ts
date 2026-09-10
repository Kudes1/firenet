import { useCallback, useEffect, useRef, useState } from "react";

// Клиентская блокировка редактирования черновика между вкладками одного
// браузера: редактор один, остальные вкладки смотрят. Это UX-защита от
// расезда данных (последний рубеж — CAS-ревизия на бэкенде), поэтому хук
// живёт на фронте и бэкенда не касается.
//
// Протокол (BroadcastChannel "firenet.lock.<scope>"):
//  - новая вкладка шлёт probe; держатель отвечает held;
//  - если ответ не пришёл за PROBE_TIMEOUT_MS — вкладка захватывает лок;
//  - держатель шлёт heartbeat каждые HEARTBEAT_MS; если он умолк дольше
//    STALE_MS (вкладку убили, pagehide не успел) — лок считается протухшим
//    и может быть захвачен по кнопке;
//  - держатель при закрытии шлёт released — смотрящая вкладка сама
//    перехватывает редактирование;
//  - pagehide/unmount снимает лок мгновенно.
// Если понадобятся не-BroadcastChannel браузеры — фолбэк добавляется внутрь
// хука, потребители не меняются.

const CHANNEL_PREFIX = "firenet.lock.";
const PROBE_TIMEOUT_MS = 300;
const HEARTBEAT_MS = 1000;
const STALE_MS = 3000;

type LockMessage =
  | { kind: "probe" }
  | { kind: "held" }
  | { kind: "heartbeat"; at: number }
  | { kind: "released" };

export type EditorLock = {
  // true — редактированием владеет другая вкладка (живой heartbeat).
  locked: boolean;
  // true — этот таб держатель; heartbeat идёт, канал оповещён.
  isHolder: boolean;
  // Принудительный захват, когда держатель умер (heartbeat протух).
  acquire: () => void;
};

export function useEditorLock(scope: string | null): EditorLock {
  const [isHolder, setHolder] = useState(false);
  const [locked, setLocked] = useState(false);
  const holderRef = useRef(false);
  const lastBeatRef = useRef(0);
  const channelRef = useRef<BroadcastChannel | null>(null);

  const acquire = useCallback(() => {
    holderRef.current = true;
    setHolder(true);
    setLocked(false);
    lastBeatRef.current = 0;
    channelRef.current?.postMessage({ kind: "heartbeat", at: Date.now() });
  }, []);

  useEffect(() => {
    if (!scope) return;
    const channel = new BroadcastChannel(CHANNEL_PREFIX + scope);
    channelRef.current = channel;

    const becomeHolder = () => {
      if (holderRef.current) return;
      holderRef.current = true;
      lastBeatRef.current = 0;
      setHolder(true);
      setLocked(false);
      channel.postMessage({ kind: "heartbeat", at: Date.now() });
    };
    const release = () => {
      if (!holderRef.current) return;
      holderRef.current = false;
      setHolder(false);
      channel.postMessage({ kind: "released" });
    };

    const beatTimer = setInterval(() => {
      if (holderRef.current) {
        channel.postMessage({ kind: "heartbeat", at: Date.now() });
        // Свой heartbeat и есть признак жизни: пока он идёт, чужой протухший
        // лок не трогаем — держателем остаётся тот, кто жив.
      } else if (lastBeatRef.current && Date.now() - lastBeatRef.current > STALE_MS) {
        lastBeatRef.current = 0;
        setLocked(false);
      }
    }, HEARTBEAT_MS);

    const probeTimer = setTimeout(() => {
      if (!holderRef.current && !lastBeatRef.current) becomeHolder();
    }, PROBE_TIMEOUT_MS);
    channel.postMessage({ kind: "probe" });

    channel.onmessage = (event: MessageEvent<LockMessage>) => {
      const msg = event.data;
      if (msg.kind === "probe") {
        if (holderRef.current) channel.postMessage({ kind: "held" });
        return;
      }
      if (msg.kind === "held") {
        if (!holderRef.current) {
          lastBeatRef.current = Date.now();
          setLocked(true);
        }
        return;
      }
      if (msg.kind === "heartbeat") {
        lastBeatRef.current = msg.at;
        if (!holderRef.current) setLocked(true);
        return;
      }
      if (msg.kind === "released") {
        lastBeatRef.current = 0;
        // Держатель закрылся сам — смотрящая вкладка перехватывает редактирование.
        becomeHolder();
      }
    };

    const cleanupTimers = () => {
      clearInterval(beatTimer);
      clearTimeout(probeTimer);
    };
    window.addEventListener("pagehide", release);
    return () => {
      cleanupTimers();
      release();
      window.removeEventListener("pagehide", release);
      channel.close();
      channelRef.current = null;
    };
  }, [scope]);

  return { locked, isHolder, acquire };
}
