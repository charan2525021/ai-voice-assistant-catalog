const DOCK_MEDIA_QUERY = "(min-width: 900px)";
export const SABLE_SIDEBAR_WIDTH_PX = 400;

type SavedProperty = { value: string; priority: string };

export interface PageDockController {
  setOpen(open: boolean): void;
  destroy(): void;
}

/**
 * Makes the injected UI behave like a browser side panel without re-parenting
 * the client's DOM. Every touched inline style is restored byte-for-byte when
 * the panel closes or is destroyed.
 */
export function createPageDock(
  document: Document,
  host: HTMLElement,
  enabled: boolean,
  widthPx = SABLE_SIDEBAR_WIDTH_PX,
): PageDockController {
  const root = document.documentElement;
  const properties = ["width", "max-width", "min-width", "box-sizing"] as const;
  const saved = new Map<string, SavedProperty>(properties.map((property) => [property, {
    value: root.style.getPropertyValue(property),
    priority: root.style.getPropertyPriority(property),
  }]));
  const priorMarker = root.getAttribute("data-sable-page-docked");
  const media = document.defaultView?.matchMedia?.(DOCK_MEDIA_QUERY);
  let open = false;
  let applied = false;
  let destroyed = false;

  const wideEnough = () => media?.matches ?? (document.defaultView?.innerWidth ?? 1_024) >= 900;
  const restore = () => {
    if (!applied) return;
    for (const property of properties) {
      const original = saved.get(property)!;
      if (original.value) root.style.setProperty(property, original.value, original.priority);
      else root.style.removeProperty(property);
    }
    if (priorMarker === null) root.removeAttribute("data-sable-page-docked");
    else root.setAttribute("data-sable-page-docked", priorMarker);
    host.setAttribute("data-sable-docked", "false");
    applied = false;
  };
  const reconcile = () => {
    if (destroyed || !enabled || !open || !wideEnough()) return restore();
    if (applied) return;
    root.style.setProperty("width", `calc(100% - ${widthPx}px)`, "important");
    root.style.setProperty("max-width", `calc(100% - ${widthPx}px)`, "important");
    root.style.setProperty("min-width", "0", "important");
    root.style.setProperty("box-sizing", "border-box", "important");
    root.setAttribute("data-sable-page-docked", "true");
    host.setAttribute("data-sable-docked", "true");
    applied = true;
  };
  const onMediaChange = () => reconcile();
  media?.addEventListener?.("change", onMediaChange);

  return {
    setOpen(value) {
      if (destroyed) return;
      open = value;
      host.setAttribute("data-sable-open", String(value));
      reconcile();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      media?.removeEventListener?.("change", onMediaChange);
      restore();
      host.removeAttribute("data-sable-open");
      host.removeAttribute("data-sable-docked");
    },
  };
}
