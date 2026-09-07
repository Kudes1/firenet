import { render, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import BannerHost from "../components/BannerHost";
import DraftBanner from "../components/DraftBanner";
import { DraftProvider } from "../draft/DraftContext";

// Одна обёртка на все тесты страниц: QueryClient без ретраев (иначе падение
// превращается в три попытки и таймаут), DraftProvider и роутер на нужном
// пути. Активный драфт задаётся через sessionStorage — ровно так, как это
// делает e2e-хелпер openWithDraft.
//
// BannerHost и DraftBanner монтируются здесь, а не внутри страниц: страницы
// выводят уведомления через notify() и не рендерят сам баннер. Без BannerHost
// тесты, ищущие data-testid="banner" (HistoryPage restore, DraftsPage 409,
// TopologyPage/RulesPage в режиме read-only), не нашли бы его и зависли бы в
// waitFor до таймаута.
export function renderPage(ui: ReactNode, path = "/ui/subnets", draftId?: string): RenderResult & {
  user: ReturnType<typeof userEvent.setup>;
} {
  if (draftId) sessionStorage.setItem("firenet-draft-id", draftId);
  else sessionStorage.clear();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <DraftProvider>
          <BannerHost />
          <DraftBanner />
          <Routes><Route path={path} element={<>{ui}</>} /></Routes>
        </DraftProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, user: userEvent.setup() };
}
