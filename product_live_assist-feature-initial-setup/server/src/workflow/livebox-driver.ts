import type { LiveBox } from "../livebox.js";
import { LiveScreenObserver, type ScreenState } from "../runtime/screen-state.js";
import type { ActionDriver, DriverResult } from "./executor.js";
import type { PrimitiveWorkflowStep, WorkflowAssertion, WorkflowTarget } from "./schema.js";

export interface WorkflowAdapter {
  call(operation: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<DriverResult>;
  check(operation: string, input: Record<string, unknown>): Promise<boolean>;
}

export class WorkflowAdapterRegistry {
  private readonly adapters = new Map<string, WorkflowAdapter>();
  register(name: string, adapter: WorkflowAdapter): void {
    if (!name.trim()) throw new Error("adapter name is required");
    this.adapters.set(name, adapter);
  }
  require(name: string): WorkflowAdapter {
    const adapter = this.adapters.get(name);
    if (!adapter) throw new Error(`workflow adapter "${name}" is not configured`);
    return adapter;
  }
}

function locator(target: WorkflowTarget, fallbackRole: string): { role: string; name: string; testId?: string } {
  const name = target.accessibleName ?? target.label ?? target.text ?? target.testId ?? target.cssFallback ?? "";
  return { role: target.role ?? fallbackRole, name, testId: target.testId };
}

function outcome(detail: string): DriverResult {
  return { ok: !detail.startsWith("NOT_FOUND") && !detail.startsWith("error:"), detail };
}

/** Generic bridge from the workflow engine to the existing browser driver. */
export class LiveBoxActionDriver implements ActionDriver {
  private readonly observer: LiveScreenObserver;
  private listBaseline = "";

  constructor(
    private readonly box: LiveBox,
    sessionId: string,
    private readonly adapters: WorkflowAdapterRegistry = new WorkflowAdapterRegistry(),
    private readonly objectPath?: (key: string) => Promise<string>,
    observer?: LiveScreenObserver,
  ) {
    this.observer = observer ?? new LiveScreenObserver(sessionId, box);
  }

  observe(): Promise<ScreenState> {
    return this.observer.observe(false);
  }

  async perform(step: PrimitiveWorkflowStep, expected: ScreenState, signal?: AbortSignal): Promise<DriverResult> {
    if (signal?.aborted) return { ok: false, detail: "workflow interrupted" };
    const current = await this.observer.observe(false);
    if (current.fingerprint !== expected.fingerprint) return { ok: false, detail: "screen changed before the action could run" };

    if (step.action === "navigate") {
      try {
        if (new URL(step.url).origin !== new URL(this.box.startUrl).origin) {
          return { ok: false, detail: "cross-origin navigation requires an explicitly configured adapter" };
        }
      } catch {
        return { ok: false, detail: "navigation URL is invalid" };
      }
      await this.box.goto(step.url);
      return { ok: true, detail: `opened ${step.url}` };
    }
    if (step.action === "click") {
      const target = locator(step.target, "button");
      return outcome(await this.box.clickByRole(target.role, target.name, target.testId));
    }
    if (step.action === "fill") {
      const target = locator(step.target, "textbox");
      return outcome(await this.box.fillByRole(target.role, target.name, step.value, step.submit, target.testId));
    }
    if (step.action === "select") {
      const target = locator(step.target, "combobox");
      return outcome(await this.box.selectByRole(target.role, target.name, step.value, target.testId));
    }
    if (step.action === "scroll") return outcome(await this.box.scroll(step.direction));
    if (step.action === "keypress") return outcome(await this.box.pressKey(step.key));
    if (step.action === "hover") {
      const target = locator(step.target, "button");
      return outcome(await this.box.hoverByRole(target.role, target.name));
    }
    if (step.action === "drag") {
      const source = locator(step.source, "button");
      const target = locator(step.target, "button");
      return outcome(await this.box.dragByRole(source.role, source.name, target.role, target.name));
    }
    if (step.action === "upload") {
      if (!this.objectPath) return { ok: false, detail: "object storage resolver is not configured" };
      const target = locator(step.target, "textbox");
      const paths = await Promise.all(step.objectKeys.map((key) => this.objectPath!(key)));
      return outcome(await this.box.uploadByRole(target.role, target.name, paths));
    }
    if (step.action === "download") {
      const target = locator(step.target, "button");
      return outcome(await this.box.downloadByRole(target.role, target.name));
    }
    if (step.action === "wait") {
      if (step.until) {
        const ok = await this.poll(step.until, step.timeoutMs ?? 10_000, signal);
        return { ok, detail: ok ? `wait condition ${step.until.kind} passed` : `wait condition ${step.until.kind} timed out` };
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, Math.min(step.milliseconds ?? 0, step.timeoutMs ?? 120_000));
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("workflow interrupted")); }, { once: true });
      });
      return { ok: true, detail: `waited ${step.milliseconds ?? 0}ms` };
    }
    return this.adapters.require(step.adapter).call(step.operation, step.input ?? {}, signal);
  }

  async check(assertion: WorkflowAssertion, baseline?: ScreenState): Promise<boolean> {
    if (assertion.kind === "text_visible") return this.box.hasText(assertion.text);
    if (assertion.kind === "text_absent") return !(await this.box.hasText(assertion.text));
    if (assertion.kind === "url_matches") {
      try { return new RegExp(assertion.pattern).test(this.box.currentUrl()); } catch { return false; }
    }
    if (assertion.kind === "element_visible") {
      const target = locator(assertion.target, "button");
      return this.box.elementVisible(target.role, target.name);
    }
    if (assertion.kind === "screen_changed") {
      const current = await this.observer.observe(false);
      return current.fingerprint !== (assertion.fromFingerprint ?? baseline?.fingerprint ?? current.fingerprint);
    }
    if (assertion.kind === "list_changed") {
      const current = await this.box.listSignature();
      const before = assertion.fromSignature ?? this.listBaseline;
      if (!this.listBaseline) this.listBaseline = current;
      return !!before && !!current && current !== before;
    }
    return this.adapters.require(assertion.adapter).check(assertion.operation, assertion.input ?? {});
  }

  private async poll(assertion: WorkflowAssertion, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) return false;
      if (await this.check(assertion)) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }
}
