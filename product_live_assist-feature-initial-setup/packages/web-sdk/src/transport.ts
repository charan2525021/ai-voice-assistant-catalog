import {
  SDK_PROTOCOL_VERSION,
  validateSdkClientMessage,
  validateSdkServerCommand,
  type SdkClientMessage,
  type SdkServerCommand,
  type SessionDescriptor,
} from "@sable/sdk-contracts";
import { SableSdkError } from "./errors.js";
import { PrivacyEngine } from "./privacy.js";
import { bytesToBase64Url, isRecord } from "./utils.js";

export type TransportState = "idle" | "connecting" | "connected" | "disconnected" | "failed" | "closed";
export type CommandListener = (command: SdkServerCommand) => void | Promise<void>;
export type StateListener = (state: TransportState, detail?: string) => void;

export interface CommandTransport {
  readonly state: TransportState;
  connect(signal?: AbortSignal): Promise<void>;
  send(message: SdkClientMessage): void;
  onCommand(listener: CommandListener): () => void;
  onState(listener: StateListener): () => void;
  close(code?: number, reason?: string): void;
}

export interface WebSocketTransportOptions {
  websocketUrl: string;
  oneTimeTicket: string;
  ticketExpiresAt: string;
  session: SessionDescriptor;
  privacy: PrivacyEngine;
  connectTimeoutMs?: number;
  webSocketFactory?: (url: string, protocols: string[]) => WebSocket;
}

function passed(result: unknown): boolean {
  return isRecord(result) && result.ok === true;
}

function ticketProtocol(ticket: string): string {
  if (!ticket || ticket.length > 16_384) throw new SableSdkError("TRANSPORT_FAILED", "Socket ticket is missing or too large");
  // Encode the complete opaque token, including JWT dots, into protocol-token-safe bytes.
  return `sable.ticket.${bytesToBase64Url(new TextEncoder().encode(ticket))}`;
}

/** Typed socket transport; server messages can name journeys but cannot send selectors or JavaScript. */
export class WebSocketCommandTransport implements CommandTransport {
  private socket?: WebSocket;
  private commandListeners = new Set<CommandListener>();
  private stateListeners = new Set<StateListener>();
  private seenCommands = new Set<string>();
  private queued: string[] = [];
  private _state: TransportState = "idle";

  constructor(private readonly options: WebSocketTransportOptions) {}

  get state(): TransportState { return this._state; }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this._state === "connected") return;
    if (Date.parse(this.options.ticketExpiresAt) <= Date.now()) throw new SableSdkError("TRANSPORT_FAILED", "One-time socket ticket has expired");
    const url = new URL(this.options.websocketUrl, globalThis.location?.href);
    if (url.protocol !== "wss:" && !(url.protocol === "ws:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
      throw new SableSdkError("TRANSPORT_FAILED", "WebSocket must use WSS except on localhost");
    }
    this.setState("connecting");
    const create = this.options.webSocketFactory ?? ((address, protocols) => new WebSocket(address, protocols));
    const socket = create(url.toString(), [ticketProtocol(this.options.oneTimeTicket)]);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        cleanup();
        socket.close(1000, "connection timeout");
        this.setState("failed", "WebSocket connection timed out");
        reject(new SableSdkError("TRANSPORT_FAILED", "WebSocket connection timed out"));
      }, this.options.connectTimeoutMs ?? 10_000);
      const cleanup = () => {
        globalThis.clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
      };
      const abort = () => {
        socket.close(1000, "stopped");
        cleanup();
        reject(new SableSdkError("ABORTED", "WebSocket connection stopped"));
      };
      const onOpen = () => {
        cleanup();
        this.setState("connected");
        for (const message of this.queued.splice(0)) socket.send(message);
        resolve();
      };
      const onError = () => {
        cleanup();
        this.setState("failed", "WebSocket connection failed");
        reject(new SableSdkError("TRANSPORT_FAILED", "WebSocket connection failed"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
      if (signal?.aborted) abort();
    });
    socket.addEventListener("message", (event) => { void this.receive(event.data).catch(() => undefined); });
    socket.addEventListener("close", () => {
      if (this._state !== "closed") this.setState("disconnected");
    });
  }

  send(message: SdkClientMessage): void {
    if (message.sessionId !== this.options.session.sessionId || !passed(validateSdkClientMessage(message))) {
      throw new SableSdkError("COMMAND_INVALID", "Refused invalid or wrong-session client message");
    }
    const serialized = JSON.stringify(this.options.privacy.scrubPayload(message));
    if (serialized.length > 256_000) throw new SableSdkError("COMMAND_INVALID", "Client message exceeded the 256 KB safety limit");
    if (this.socket?.readyState === 1) this.socket.send(serialized);
    else if (["idle", "connecting"].includes(this._state) && this.queued.length < 20) this.queued.push(serialized);
    else throw new SableSdkError("TRANSPORT_FAILED", "Command transport is not connected");
  }

  onCommand(listener: CommandListener): () => void {
    this.commandListeners.add(listener);
    return () => this.commandListeners.delete(listener);
  }

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this._state);
    return () => this.stateListeners.delete(listener);
  }

  close(code = 1000, reason = "SDK shutdown"): void {
    this._state = "closed";
    this.queued = [];
    this.socket?.close(code, reason.slice(0, 123));
    this.socket = undefined;
    this.setState("closed");
  }

  private async receive(data: unknown): Promise<void> {
    const serialized = typeof data === "string" ? data : data instanceof Blob ? await data.text() : "";
    if (!serialized || serialized.length > 256_000) return;
    let value: unknown;
    try { value = JSON.parse(serialized); } catch { return; }
    if (!passed(validateSdkServerCommand(value))) return;
    const command = value as SdkServerCommand;
    if (command.schemaVersion !== SDK_PROTOCOL_VERSION || command.sessionId !== this.options.session.sessionId) return;
    if (this.seenCommands.has(command.commandId)) return;
    this.seenCommands.add(command.commandId);
    if (this.seenCommands.size > 1_000) this.seenCommands.delete(this.seenCommands.values().next().value as string);
    for (const listener of this.commandListeners) await listener(command);
  }

  private setState(state: TransportState, detail?: string): void {
    this._state = state;
    for (const listener of this.stateListeners) listener(state, detail);
  }
}
