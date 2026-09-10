import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorLock } from "./editorLock";

// Две «вкладки» — два экземпляра хука в одном jsdom: BroadcastChannel
// доставляет сообщения в рамках того же канала, как и в браузере.
type Probe = { locked: boolean; isHolder: boolean };

let recorder: (tag: string, s: Probe) => void;

function Harness({ scope, tag }: { scope: string | null; tag: string }) {
  const lock = useEditorLock(scope);
  recorder(tag, { locked: lock.locked, isHolder: lock.isHolder });
  return null;
}

describe("useEditorLock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("first tab becomes holder, second sees the lock", async () => {
    const states: Record<string, Probe | undefined> = {};
    recorder = (tag, s) => { states[tag] = s; };
    render(
      <>
        <Harness scope="draft:1" tag="a" />
        <Harness scope="draft:1" tag="b" />
      </>,
    );
    await act(() => vi.advanceTimersByTimeAsync(400));
    const a = states.a!;
    const b = states.b!;
    // Держатель ровно один, второй таб видит блокировку.
    expect([a.isHolder, b.isHolder].filter(Boolean).length).toBe(1);
    const viewer = a.isHolder ? b : a;
    expect(viewer.locked).toBe(true);
  });

  it("releases on unmount and the peer takes over", async () => {
    const states: Record<string, Probe | undefined> = {};
    recorder = (tag, s) => { states[tag] = s; };
    const first = render(<Harness scope="draft:1" tag="a" />);
    await act(() => vi.advanceTimersByTimeAsync(400));
    // Вторая вкладка подключается, когда первая уже держатель.
    render(<Harness scope="draft:1" tag="b" />);
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(states.b).toEqual({ locked: true, isHolder: false });

    first.unmount(); // закрытие вкладки-держателя
    await act(() => vi.advanceTimersByTimeAsync(100));
    // released — сосед сразу перехватывает редактирование.
    expect(states.b).toEqual({ locked: false, isHolder: true });
  });

  it("ignores a stale lock and can acquire it", async () => {
    const states: Record<string, Probe | undefined> = {};
    recorder = (tag, s) => { states[tag] = s; };
    const { rerender } = render(<Harness scope={null} tag="a" />);
    // Вкладка b изначально смотрит (лок якобы держит кто-то мёртвый):
    // эмулируем «ответ held» без последующего heartbeat — для этого
    // подсунем держатель, который перестанет слать heartbeat.
    const holder = render(<Harness scope="draft:1" tag="holder" />);
    await act(() => vi.advanceTimersByTimeAsync(400));
    rerender(<Harness scope="draft:1" tag="a" />);
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(states.a).toEqual({ locked: true, isHolder: false });
    // Держатель умер без released: heartbeat протухает…
    holder.unmount();
    await act(() => vi.advanceTimersByTimeAsync(3000 + 1100));
    // …лок считается свободным и вкладка может захватить его по кнопке.
    expect(states.a!.locked).toBe(false);
  });
});
