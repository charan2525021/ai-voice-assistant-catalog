import type { ApprovalRequest, GuidedDemoSnapshot, SableAgent, SableAgentEvent } from "@sable/web-sdk";
import { approvalCopy } from "./copy.js";
import { createPageDock } from "./layout.js";
import { UI_STYLES } from "./styles.js";
import { ConversationTranscript } from "./transcript.js";

export interface VoiceUiHooks {
  enabled: boolean;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
  /** Receives server-authorized speech output. The host may use its TTS provider or speechSynthesis. */
  speak?(text: string, context: { turnId: string; voice?: string }): Promise<void> | void;
  /** Stops in-progress speech immediately, including when the user presses Stop or starts listening. */
  cancelSpeech?(): Promise<void> | void;
}

export interface SableUiConfig {
  title?: string;
  greeting?: string;
  placeholder?: string;
  initiallyOpen?: boolean;
  /** Dock beside the page like an extension, or float over it. Defaults to overlay. */
  layout?: "docked" | "overlay";
  approvalUi?: boolean;
  voice?: VoiceUiHooks;
  styleNonce?: string;
  stylesheetUrl?: string;
  host?: HTMLElement;
  onEvent?: (event: SableAgentEvent) => void;
}

export interface SableUiController {
  readonly host: HTMLElement;
  open(): void;
  close(): void;
  setListening(listening: boolean): void;
  destroy(): void;
}

const mountedInterfaces = new WeakMap<SableAgent, SableUiController>();

function safelyRunVoiceHook(operation: (() => Promise<void> | void) | undefined): void {
  if (!operation) return;
  try { void Promise.resolve(operation()).catch(() => undefined); }
  catch { /* A host voice provider must never break the assistant UI. */ }
}

/** Routes SDK speech events to a client-owned TTS provider without coupling the UI to one vendor. */
export function dispatchVoiceOutput(voice: VoiceUiHooks | undefined, event: SableAgentEvent): void {
  if (!voice) return;
  if (event.type === "speak" && voice.speak) {
    safelyRunVoiceHook(() => voice.speak!(event.text, { turnId: event.turnId, voice: event.voice }));
    return;
  }
  if (event.type === "state" && ["stopped", "disabled", "failed", "shutdown"].includes(event.state)) {
    safelyRunVoiceHook(voice.cancelSpeech ? () => voice.cancelSpeech!() : undefined);
  }
}

function element<K extends keyof HTMLElementTagNameMap>(document: Document, tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/** Mounts one isolated UI. Page data is inserted with textContent, never HTML. */
export function mountSableUi(agent: SableAgent, config: SableUiConfig = {}): SableUiController {
  const existing = mountedInterfaces.get(agent);
  if (existing) return existing;
  const document = config.host?.ownerDocument ?? globalThis.document;
  if (!document) throw new Error("Sable UI requires a browser document");
  const host = config.host ?? element(document, "div");
  host.setAttribute("data-sable-ui", "");
  if (!host.isConnected) (document.body ?? document.documentElement).append(host);
  const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });

  if (config.stylesheetUrl) {
    const link = element(document, "link");
    link.rel = "stylesheet";
    link.href = config.stylesheetUrl;
    root.append(link);
  } else {
    const style = element(document, "style");
    if (config.styleNonce) style.nonce = config.styleNonce;
    style.textContent = UI_STYLES;
    root.append(style);
  }

  const launcher = element(document, "button", "launcher");
  launcher.type = "button";
  launcher.textContent = "Ask";
  launcher.setAttribute("aria-label", `Open ${config.title ?? "Sable"}`);
  const panel = element(document, "section", "panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", config.title ?? "Sable assistant");
  const header = element(document, "header", "header");
  const identity = element(document, "div", "identity");
  const title = element(document, "strong", "title");
  title.textContent = config.title ?? "Sable";
  const status = element(document, "div", "status");
  status.setAttribute("role", "status");
  status.textContent = "Starting…";
  identity.append(title, status);
  const stop = element(document, "button", "stop");
  stop.type = "button";
  stop.textContent = "Stop";
  stop.setAttribute("aria-label", "Stop the current Sable action");
  const minimize = element(document, "button", "icon");
  minimize.type = "button";
  minimize.textContent = "—";
  minimize.setAttribute("aria-label", "Minimize assistant");
  header.append(identity, stop, minimize);

  const messages = element(document, "div", "messages");
  messages.setAttribute("role", "log");
  messages.setAttribute("aria-live", "polite");
  messages.setAttribute("aria-relevant", "additions text");
  const composer = element(document, "form", "composer");
  const input = element(document, "input");
  input.type = "text";
  input.autocomplete = "off";
  input.placeholder = config.placeholder ?? "Ask about this page…";
  input.setAttribute("aria-label", "Message Sable");
  const voice = element(document, "button", "voice");
  voice.type = "button";
  voice.textContent = "Mic";
  // Built-in cloud voice is the default. A host-provided hook remains an explicit override.
  voice.hidden = !(config.voice?.enabled || agent.snapshot().voiceAvailable);
  voice.setAttribute("aria-label", "Start voice input");
  voice.setAttribute("aria-pressed", "false");
  const send = element(document, "button", "send");
  send.type = "submit";
  send.textContent = "Send";
  const continueJourney = element(document, "button", "continue");
  continueJourney.type = "button";
  continueJourney.textContent = "Continue";
  continueJourney.hidden = true;
  const demoActions = element(document, "div", "demo-actions");
  demoActions.hidden = true;
  const startDemo = element(document, "button", "demo-control");
  startDemo.type = "button";
  startDemo.textContent = "Start demo";
  const retryDemo = element(document, "button", "demo-control");
  retryDemo.type = "button";
  retryDemo.textContent = "Retry";
  const skipDemo = element(document, "button", "demo-control");
  skipDemo.type = "button";
  skipDemo.textContent = "Skip";
  demoActions.append(startDemo, continueJourney, retryDemo, skipDemo);
  composer.append(demoActions, input, voice, send);

  const approval = element(document, "div", "approval");
  approval.hidden = true;
  const approvalCard = element(document, "div", "approval-card");
  approvalCard.setAttribute("role", "alertdialog");
  approvalCard.setAttribute("aria-modal", "true");
  const approvalTitle = element(document, "h2", "approval-title");
  const approvalDetail = element(document, "div", "approval-detail");
  const approvalActions = element(document, "div", "approval-actions");
  const deny = element(document, "button", "deny");
  deny.type = "button";
  deny.textContent = "Cancel";
  const approve = element(document, "button", "approve");
  approve.type = "button";
  approve.textContent = "Approve";
  approvalActions.append(deny, approve);
  approvalCard.append(approvalTitle, approvalDetail, approvalActions);
  approval.append(approvalCard);
  panel.append(header, messages, composer, approval);
  root.append(launcher, panel);

  // Overlay is the production default because it cannot change the client's
  // page width. Docking remains available as an explicit host choice.
  const pageDock = createPageDock(document, host, !config.host && config.layout === "docked");

  const partialMessages = new Map<string, HTMLElement>();
  const renderedMessages = new Map<string, HTMLElement>();
  const transcript = new ConversationTranscript();
  const renderedNarrationKeys = new Set<string>();
  let listening = false;
  let approvalResolver: ((approved: boolean) => void) | undefined;
  let approvalCleanup: (() => void) | undefined;
  let demoSnapshot = agent.snapshot().demo;

  const renderDemoControls = (snapshot: GuidedDemoSnapshot | undefined) => {
    demoSnapshot = snapshot;
    const controls = snapshot?.controls;
    startDemo.hidden = !controls?.canStart;
    continueJourney.hidden = !controls?.canContinue;
    retryDemo.hidden = !controls?.canRetry;
    skipDemo.hidden = !controls?.canSkip;
    demoActions.hidden = !snapshot?.enabled || !controls || !Object.values(controls).some(Boolean);
  };

  const session = agent.snapshot().session;
  const uiStorageKey = session ? `sable:ui:${session.installationId}:${session.userId}:${session.catalogVersionId}` : undefined;
  const storedOpen = (() => {
    if (!uiStorageKey) return undefined;
    try { const value = globalThis.sessionStorage?.getItem(uiStorageKey); return value === "open" ? true : value === "closed" ? false : undefined; }
    catch { return undefined; }
  })();
  const showPanel = (open: boolean) => {
    panel.hidden = !open;
    launcher.hidden = open;
    pageDock.setOpen(open);
    if (uiStorageKey) {
      try { globalThis.sessionStorage?.setItem(uiStorageKey, open ? "open" : "closed"); } catch { /* UI persistence is best effort. */ }
    }
    if (open) input.focus();
  };
  const renderVoiceButton = () => {
    voice.setAttribute("aria-pressed", String(listening));
    voice.setAttribute("aria-label", listening ? "End continuous voice" : "Start continuous voice");
    voice.textContent = listening ? "End Voice" : "Mic";
  };
  const appendMessage = (role: "assistant" | "user", text: string, turnId?: string, partial = false) => {
    let message = turnId ? renderedMessages.get(turnId) ?? partialMessages.get(turnId) : undefined;
    if (!message) {
      message = element(document, "div", `message ${role}`);
      const speaker = element(document, "span", "speaker");
      speaker.textContent = role === "assistant" ? (config.title ?? "Sable") : "You";
      const content = element(document, "span", "content");
      message.append(speaker, content);
      messages.append(message);
      if (turnId) renderedMessages.set(turnId, message);
      if (turnId && partial) partialMessages.set(turnId, message);
    }
    const content = message.querySelector<HTMLElement>(".content");
    if (content) content.textContent = text;
    message.setAttribute("data-partial", String(partial));
    if (turnId && !partial) partialMessages.delete(turnId);
    while (messages.childElementCount > 100) {
      const removed = messages.firstElementChild as HTMLElement | null;
      removed?.remove();
      for (const [key, value] of renderedMessages) if (value === removed) renderedMessages.delete(key);
    }
    messages.scrollTop = messages.scrollHeight;
  };

  renderVoiceButton();
  renderDemoControls(demoSnapshot);
  const restoredTranscript = agent.getTranscript();
  for (const message of restoredTranscript) appendMessage(message.role, message.text, message.key, false);
  if (!restoredTranscript.length && config.greeting) appendMessage("assistant", config.greeting, "assistant:greeting");
  showPanel(config.initiallyOpen ?? storedOpen ?? false);

  launcher.addEventListener("click", () => showPanel(true));
  minimize.addEventListener("click", () => showPanel(false));
  stop.addEventListener("click", () => {
    if (config.voice?.cancelSpeech) safelyRunVoiceHook(() => config.voice!.cancelSpeech!());
    else agent.cancelSpeech();
    if (demoSnapshot?.controls.canStop) agent.controlDemo("stop");
    else agent.stop("user");
  });
  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    appendMessage("user", text);
    agent.sendMessage(text, "text");
    input.value = "";
  });
  voice.addEventListener("click", () => {
    const shouldListen = !listening;
    listening = shouldListen;
    renderVoiceButton();
    if (config.voice) {
      if (shouldListen) safelyRunVoiceHook(config.voice.cancelSpeech ? () => config.voice!.cancelSpeech!() : undefined);
      safelyRunVoiceHook(shouldListen ? () => config.voice!.start() : () => config.voice!.stop());
      return;
    }
    if (shouldListen) agent.cancelSpeech();
    void (shouldListen ? agent.startVoice() : agent.stopVoice()).catch((error: unknown) => {
      listening = false;
      renderVoiceButton();
      status.textContent = error instanceof Error ? error.message : "Voice input failed";
    });
  });
  const demoControl = (action: "start" | "continue" | "retry" | "skip") => {
    try {
      agent.controlDemo(action);
      appendMessage("user", action === "start" ? "Start demo" : action[0]!.toUpperCase() + action.slice(1));
      renderDemoControls(agent.snapshot().demo);
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "That demo action is not available";
    }
  };
  startDemo.addEventListener("click", () => demoControl("start"));
  continueJourney.addEventListener("click", () => {
    if (demoSnapshot?.enabled) demoControl("continue");
    else {
      continueJourney.hidden = true;
      appendMessage("user", "Continue");
      agent.sendMessage("continue", "text");
    }
  });
  retryDemo.addEventListener("click", () => demoControl("retry"));
  skipDemo.addEventListener("click", () => demoControl("skip"));

  const resolveApproval = (approved: boolean) => {
    approval.hidden = true;
    approvalResolver?.(approved);
    approvalResolver = undefined;
    approvalCleanup?.();
    approvalCleanup = undefined;
    input.focus();
  };
  deny.addEventListener("click", () => resolveApproval(false));
  approve.addEventListener("click", () => resolveApproval(true));
  if (config.approvalUi ?? true) {
    agent.setApprovalHandler((request: ApprovalRequest, signal?: AbortSignal) => new Promise<boolean>((resolve) => {
      approvalResolver?.(false);
      approvalCleanup?.();
      approvalResolver = resolve;
      const copy = approvalCopy(request);
      approvalTitle.textContent = copy.title;
      approvalDetail.textContent = copy.detail;
      approval.hidden = false;
      approve.focus();
      const onAbort = () => resolveApproval(false);
      signal?.addEventListener("abort", onAbort, { once: true });
      const remaining = Math.max(0, Date.parse(request.expiresAt) - Date.now());
      const timer = globalThis.setTimeout(() => resolveApproval(false), Math.min(remaining, 2_147_483_647));
      approvalCleanup = () => {
        globalThis.clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
    }));
  }

  const unsubscribe = agent.subscribe((event) => {
    config.onEvent?.(event);
    dispatchVoiceOutput(config.voice, event);
    if (event.type === "state") status.textContent = event.detail || event.state;
    if (event.type === "voice") {
      listening = event.sessionActive;
      renderVoiceButton();
      status.textContent = event.detail ?? (event.state === "listening" ? "Listening…" : event.state === "processing" ? "Understanding…" : event.state);
      if (event.text) {
        const update = transcript.userVoice(event.text, event.final === true);
        appendMessage(update.role, update.text, update.key, update.partial);
      }
    }
    if (event.type === "assistant") {
      const update = transcript.assistant(event.turnId, event.text, event.partial);
      appendMessage(update.role, update.text, update.key, update.partial);
    }
    if (event.type === "narration") {
      const update = transcript.journeyNarration(event.turnId, event.journeyId, event.stepId, event.text);
      if (renderedNarrationKeys.has(update.key)) return;
      renderedNarrationKeys.add(update.key);
      appendMessage(update.role, update.text, update.key, update.partial);
    }
    if (event.type === "demo") {
      renderDemoControls(event.snapshot);
      status.textContent = event.snapshot.phase === "awaiting_resume" ? "Ready to resume" : `Demo: ${event.snapshot.phase.replace(/_/g, " ")}`;
    }
    if (event.type === "demo_utterance") {
      appendMessage("assistant", event.request.text, `assistant:demo:${event.request.key}`, false);
    }
    if (event.type === "continuity" && event.state === "restored" && event.transcript) {
      for (const message of event.transcript) appendMessage(message.role, message.text, message.key, false);
    }
    if (event.type === "journey") {
      status.textContent = event.state === "started" ? "Working…" : event.state === "paused" ? "Paused safely" : event.state;
      if (!demoSnapshot?.enabled) continueJourney.hidden = event.state !== "paused";
    }
    if (event.type === "error") {
      status.textContent = event.message;
      appendMessage("assistant", `I couldn't continue: ${event.message}`);
    }
  });

  const controller: SableUiController = {
    host,
    open: () => showPanel(true),
    close: () => showPanel(false),
    setListening(value: boolean) {
      listening = value;
      renderVoiceButton();
    },
    destroy() {
      approvalResolver?.(false);
      approvalCleanup?.();
      if (config.voice?.cancelSpeech) safelyRunVoiceHook(() => config.voice!.cancelSpeech!());
      else agent.cancelSpeech();
      if (listening) {
        if (config.voice) safelyRunVoiceHook(() => config.voice!.stop());
        else void agent.stopVoice().catch(() => undefined);
      }
      unsubscribe();
      pageDock.destroy();
      host.remove();
      mountedInterfaces.delete(agent);
    },
  };
  mountedInterfaces.set(agent, controller);
  return controller;
}

export { approvalCopy } from "./copy.js";
