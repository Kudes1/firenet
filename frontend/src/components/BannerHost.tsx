import { useSyncExternalStore } from "react";
import { getNotice, subscribe } from "./notify";

export default function BannerHost() {
  const notice = useSyncExternalStore(subscribe, getNotice, () => null);
  if (!notice) return null;
  return (
    <div id="error-banner" className={`banner ${notice.kind}`} role="status" data-testid="banner">
      {notice.message}
    </div>
  );
}
