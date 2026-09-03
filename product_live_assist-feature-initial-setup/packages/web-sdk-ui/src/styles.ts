export const UI_STYLES = `
:host {
  all: initial;
  color-scheme: light dark;
  --sable-accent: #2563eb;
  --sable-bg: #ffffff;
  --sable-panel: #f8fafc;
  --sable-text: #0f172a;
  --sable-muted: #64748b;
  --sable-border: #dbe3ee;
  --sable-danger: #b91c1c;
  position: fixed;
  z-index: 2147483000;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(400px, 100vw);
  font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  pointer-events: none;
}
:host([data-sable-open="false"]) { top: auto; left: auto; width: auto; height: auto; right: 20px; bottom: 20px; }
* { box-sizing: border-box; }
button, input { font: inherit; }
button { cursor: pointer; }
.launcher {
  width: 54px; height: 54px; border: 0; border-radius: 999px;
  color: white; background: var(--sable-accent); box-shadow: 0 12px 28px #0f172a33;
  font-weight: 700; pointer-events: auto;
}
.panel {
  width: 100%; height: 100%;
  display: grid; grid-template-rows: auto 1fr auto; overflow: hidden;
  color: var(--sable-text); background: var(--sable-bg); border: 1px solid var(--sable-border);
  border-width: 0 0 0 1px; border-radius: 0; box-shadow: -12px 0 36px #0f172a2e;
  pointer-events: auto;
}
.panel[hidden], .launcher[hidden], .approval[hidden], .demo-actions[hidden], .demo-control[hidden], .continue[hidden] { display: none; }
.header { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--sable-border); }
.identity { min-width: 0; flex: 1; }
.title { display: block; font-weight: 750; }
.status { color: var(--sable-muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.icon, .stop { border: 0; border-radius: 9px; padding: 7px 9px; background: var(--sable-panel); color: var(--sable-text); }
.stop { color: var(--sable-danger); font-weight: 700; }
.messages { overflow: auto; padding: 14px; display: flex; flex-direction: column; gap: 9px; }
.message { max-width: 88%; padding: 9px 11px; border-radius: 13px; white-space: pre-wrap; overflow-wrap: anywhere; }
.message.assistant { align-self: flex-start; background: var(--sable-panel); }
.message.user { align-self: flex-end; color: white; background: var(--sable-accent); }
.message .speaker { display: block; margin-bottom: 2px; color: inherit; opacity: .72; font-size: 11px; font-weight: 700; }
.message[data-partial="true"] .content::after { content: " …"; opacity: .65; }
.composer { display: grid; grid-template-columns: 1fr auto auto; gap: 7px; padding: 12px; border-top: 1px solid var(--sable-border); }
.demo-actions { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 7px; }
.demo-control, .continue { border: 1px solid var(--sable-accent); border-radius: 10px; padding: 7px 11px; color: var(--sable-accent); background: var(--sable-bg); font-weight: 650; }
.composer input { min-width: 0; border: 1px solid var(--sable-border); border-radius: 10px; padding: 9px 10px; color: var(--sable-text); background: var(--sable-bg); }
.send, .voice { border: 0; border-radius: 10px; padding: 9px 11px; color: white; background: var(--sable-accent); }
.voice { background: #334155; }
.voice[aria-pressed="true"] { background: #b91c1c; }
button:focus-visible, input:focus-visible { outline: 3px solid #60a5fa; outline-offset: 2px; }
.approval { position: absolute; inset: 0; display: grid; place-items: center; padding: 18px; background: #0f172a99; }
.approval-card { width: 100%; padding: 18px; border-radius: 14px; color: var(--sable-text); background: var(--sable-bg); box-shadow: 0 18px 40px #0005; }
.approval-title { margin: 0 0 7px; font-size: 16px; }
.approval-detail { color: var(--sable-muted); white-space: pre-wrap; }
.approval-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.deny, .approve { border: 1px solid var(--sable-border); border-radius: 9px; padding: 8px 12px; background: var(--sable-bg); color: var(--sable-text); }
.approve { border-color: var(--sable-accent); color: white; background: var(--sable-accent); }
@media (prefers-color-scheme: dark) {
  :host { --sable-bg: #101721; --sable-panel: #1b2533; --sable-text: #f1f5f9; --sable-muted: #a7b3c4; --sable-border: #344154; }
}
@media (max-width: 899px) {
  :host([data-sable-open="true"]) { inset: 12px; width: auto; }
  .panel { border: 1px solid var(--sable-border); border-radius: 18px; box-shadow: 0 24px 60px #0f172a3d; }
}
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
`;
