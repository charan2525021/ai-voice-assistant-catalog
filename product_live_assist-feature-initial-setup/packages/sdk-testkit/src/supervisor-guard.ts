type MethodHost = Record<PropertyKey, unknown>;

export type SupervisorActionScope =
  | "page"
  | "locator"
  | "frameLocator"
  | "mouse"
  | "keyboard"
  | "touchscreen";

export interface SupervisorActionAttempt {
  scope: SupervisorActionScope;
  method: string;
  blocked: boolean;
  at: number;
}

export interface SupervisorOnlyGuard<TPage extends object> {
  /** The only page reference a browser test should retain. */
  page: TPage;
  attempts: readonly SupervisorActionAttempt[];
  startSdkExecution(): void;
  stopSdkExecution(): void;
  isSdkExecuting(): boolean;
  assertNoViolations(): void;
}

export class SupervisorActionViolation extends Error {
  readonly scope: SupervisorActionScope;
  readonly method: string;

  constructor(scope: SupervisorActionScope, method: string) {
    super(
      `Playwright ${scope}.${method} is forbidden after SDK execution starts; ` +
        "the SDK must perform the journey action",
    );
    this.name = "SupervisorActionViolation";
    this.scope = scope;
    this.method = method;
  }
}

const PAGE_ACTIONS = new Set([
  "check",
  "click",
  "dblclick",
  "dispatchEvent",
  "dragAndDrop",
  "fill",
  "focus",
  "goBack",
  "goForward",
  "goto",
  "hover",
  "press",
  "reload",
  "selectOption",
  "setChecked",
  "setContent",
  "setInputFiles",
  "tap",
  "type",
  "uncheck",
]);

const LOCATOR_ACTIONS = new Set([
  "check",
  "clear",
  "click",
  "dblclick",
  "dispatchEvent",
  "dragTo",
  "fill",
  "focus",
  "hover",
  "press",
  "pressSequentially",
  "scrollIntoViewIfNeeded",
  "selectOption",
  "setChecked",
  "setInputFiles",
  "tap",
  "type",
  "uncheck",
]);

const INPUT_DEVICE_ACTIONS = new Set([
  "click",
  "dblclick",
  "down",
  "insertText",
  "move",
  "press",
  "tap",
  "type",
  "up",
  "wheel",
]);

const LOCATOR_FACTORIES = new Set([
  "$",
  "$$",
  "frameLocator",
  "getByAltText",
  "getByLabel",
  "getByPlaceholder",
  "getByRole",
  "getByTestId",
  "getByText",
  "getByTitle",
  "locator",
]);

interface GuardState {
  active: boolean;
  attempts: SupervisorActionAttempt[];
  locatorCache: WeakMap<object, object>;
}

function blockOrRecord(
  state: GuardState,
  scope: SupervisorActionScope,
  method: string,
): void {
  const blocked = state.active;
  state.attempts.push({ scope, method, blocked, at: Date.now() });
  if (blocked) throw new SupervisorActionViolation(scope, method);
}

function wrapDevice<T extends object>(
  device: T,
  scope: "mouse" | "keyboard" | "touchscreen",
  state: GuardState,
): T {
  return new Proxy(device, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof property === "string" && typeof value === "function") {
        return (...args: unknown[]) => {
          if (INPUT_DEVICE_ACTIONS.has(property)) blockOrRecord(state, scope, property);
          return Reflect.apply(value, target, args) as unknown;
        };
      }
      return value;
    },
  });
}

function wrapLocator<T extends object>(
  locator: T,
  state: GuardState,
  scope: "locator" | "frameLocator" = "locator",
): T {
  const cached = state.locatorCache.get(locator);
  if (cached) return cached as T;

  const proxy = new Proxy(locator, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof property !== "string" || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (LOCATOR_ACTIONS.has(property)) blockOrRecord(state, scope, property);
        const result = Reflect.apply(value, target, args) as unknown;
        if (
          result &&
          typeof result === "object" &&
          (LOCATOR_FACTORIES.has(property) || property === "first" || property === "last" || property === "nth")
        ) {
          return wrapLocator(
            result,
            state,
            property === "frameLocator" ? "frameLocator" : scope,
          );
        }
        return result;
      };
    },
  });
  state.locatorCache.set(locator, proxy);
  return proxy;
}

export function createSupervisorOnlyGuard<TPage extends object>(
  rawPage: TPage,
): SupervisorOnlyGuard<TPage> {
  const state: GuardState = {
    active: false,
    attempts: [],
    locatorCache: new WeakMap(),
  };
  const deviceCache = new Map<PropertyKey, object>();

  const page = new Proxy(rawPage, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (
        (property === "mouse" || property === "keyboard" || property === "touchscreen") &&
        value &&
        typeof value === "object"
      ) {
        const cached = deviceCache.get(property);
        if (cached) return cached;
        const wrapped = wrapDevice(
          value,
          property as "mouse" | "keyboard" | "touchscreen",
          state,
        );
        deviceCache.set(property, wrapped);
        return wrapped;
      }
      if (typeof property !== "string" || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (PAGE_ACTIONS.has(property)) blockOrRecord(state, "page", property);
        const result = Reflect.apply(value, target, args) as unknown;
        if (result && typeof result === "object" && LOCATOR_FACTORIES.has(property)) {
          return wrapLocator(
            result,
            state,
            property === "frameLocator" ? "frameLocator" : "locator",
          );
        }
        return result;
      };
    },
  });

  return {
    page,
    get attempts() {
      return state.attempts;
    },
    startSdkExecution: () => {
      state.active = true;
    },
    stopSdkExecution: () => {
      state.active = false;
    },
    isSdkExecuting: () => state.active,
    assertNoViolations: () => {
      const violation = state.attempts.find((attempt) => attempt.blocked);
      if (violation) throw new SupervisorActionViolation(violation.scope, violation.method);
    },
  };
}

export interface SupervisorScenario<TPage extends object> {
  page: TPage;
  prepare(page: TPage): Promise<void>;
  startSdk(page: TPage): Promise<void>;
  runSdkJourney(): Promise<void>;
  supervise(page: TPage): Promise<void>;
  stopSdk?(): Promise<void>;
}

export async function runSupervisorOnlyScenario<TPage extends object>(
  scenario: SupervisorScenario<TPage>,
): Promise<SupervisorOnlyGuard<TPage>> {
  const guard = createSupervisorOnlyGuard(scenario.page);
  await scenario.prepare(guard.page);
  await scenario.startSdk(guard.page);
  guard.startSdkExecution();
  try {
    await scenario.runSdkJourney();
    await scenario.supervise(guard.page);
    guard.assertNoViolations();
    return guard;
  } finally {
    guard.stopSdkExecution();
    await scenario.stopSdk?.();
  }
}
