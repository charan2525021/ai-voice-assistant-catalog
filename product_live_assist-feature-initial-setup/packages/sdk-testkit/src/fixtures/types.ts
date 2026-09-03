export type FixtureOrigin = "primary" | "secondary";

export interface FixtureRoute {
  origin?: FixtureOrigin;
  path: string;
  html: string;
  status?: number;
  headers?: Readonly<Record<string, string>>;
}

export type ExpectedCompatibility =
  | "SDK_DIRECT"
  | "NEEDS_STABLE_MARKER"
  | "NEEDS_REGISTERED_TOOL"
  | "NEEDS_USER_GESTURE"
  | "NEEDS_FRAME_BRIDGE"
  | "EXTENSION_ONLY"
  | "HUMAN_ONLY"
  | "UNSUPPORTED";

export interface FixtureExpectation {
  journeyId?: string;
  startScreen?: string;
  successText?: string;
  targetControl?: string;
  expectedCompatibility?: ExpectedCompatibility;
  privateValues?: readonly string[];
  notes?: readonly string[];
}

export interface BrowserFixture {
  id: string;
  title: string;
  description: string;
  initialPath: string;
  routes: readonly FixtureRoute[];
  expectation: FixtureExpectation;
}

export interface FixtureOrigins {
  primaryOrigin: string;
  secondaryOrigin: string;
}

const ORIGIN_TOKENS: Readonly<Record<keyof FixtureOrigins, string>> = {
  primaryOrigin: "{{PRIMARY_ORIGIN}}",
  secondaryOrigin: "{{SECONDARY_ORIGIN}}",
};

function replaceOrigins(value: string, origins: FixtureOrigins): string {
  return value
    .split(ORIGIN_TOKENS.primaryOrigin)
    .join(origins.primaryOrigin.replace(/\/$/, ""))
    .split(ORIGIN_TOKENS.secondaryOrigin)
    .join(origins.secondaryOrigin.replace(/\/$/, ""));
}

export function materializeFixture(
  fixture: BrowserFixture,
  origins: FixtureOrigins,
): BrowserFixture {
  return {
    ...fixture,
    routes: fixture.routes.map((route) => ({
      ...route,
      html: replaceOrigins(route.html, origins),
      headers: route.headers
        ? Object.fromEntries(
            Object.entries(route.headers).map(([key, value]) => [
              key,
              replaceOrigins(value, origins),
            ]),
          )
        : undefined,
    })),
  };
}

export function findFixtureRoute(
  fixture: BrowserFixture,
  urlOrPath: string,
  origin: FixtureOrigin = "primary",
): FixtureRoute | undefined {
  const path = urlOrPath.startsWith("http")
    ? new URL(urlOrPath).pathname
    : new URL(urlOrPath, "https://fixture.invalid").pathname;
  return fixture.routes.find(
    (route) => (route.origin ?? "primary") === origin && route.path === path,
  );
}
