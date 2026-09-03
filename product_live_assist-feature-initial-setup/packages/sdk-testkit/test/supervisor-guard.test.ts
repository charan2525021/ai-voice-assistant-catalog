import assert from "node:assert/strict";
import test from "node:test";
import {
  createSupervisorOnlyGuard,
  runSupervisorOnlyScenario,
  SupervisorActionViolation,
} from "../src/supervisor-guard.js";

class FakeLocator {
  clickCount = 0;

  click(): Promise<void> {
    this.clickCount += 1;
    return Promise.resolve();
  }

  fill(): Promise<void> {
    return Promise.resolve();
  }

  getByRole(): FakeLocator {
    return this;
  }

  first(): FakeLocator {
    return this;
  }

  textContent(): Promise<string> {
    return Promise.resolve("Project created successfully");
  }
}

class FakePage {
  readonly target = new FakeLocator();
  readonly mouse = {
    click: async () => undefined,
    move: async () => undefined,
  };

  goto(): Promise<void> {
    return Promise.resolve();
  }

  click(): Promise<void> {
    return Promise.resolve();
  }

  getByRole(): FakeLocator {
    return this.target;
  }

  locator(): FakeLocator {
    return this.target;
  }

  screenshot(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array([1, 2, 3]));
  }
}

test("allows setup actions, then blocks page and input-device actions", async () => {
  const guard = createSupervisorOnlyGuard(new FakePage());
  await guard.page.goto();
  guard.startSdkExecution();

  assert.throws(() => guard.page.click(), SupervisorActionViolation);
  assert.throws(() => guard.page.mouse.click(), SupervisorActionViolation);
  assert.equal((await guard.page.screenshot()).byteLength, 3);
  assert.equal(guard.attempts.filter((attempt) => attempt.blocked).length, 2);
});

test("blocks locator actions through chained locator factories", async () => {
  const guard = createSupervisorOnlyGuard(new FakePage());
  const button = guard.page.getByRole().first().getByRole();
  guard.startSdkExecution();

  assert.throws(() => button.click(), SupervisorActionViolation);
  assert.equal(await button.textContent(), "Project created successfully");
});

test("scenario helper keeps Playwright in supervisor mode during SDK replay", async () => {
  const rawPage = new FakePage();
  let sdkRan = false;
  const guard = await runSupervisorOnlyScenario({
    page: rawPage,
    prepare: async (page) => page.goto(),
    startSdk: async () => undefined,
    runSdkJourney: async () => {
      sdkRan = true;
    },
    supervise: async (page) => {
      assert.equal(await page.locator().textContent(), "Project created successfully");
    },
  });
  assert.equal(sdkRan, true);
  assert.equal(guard.attempts.some((attempt) => attempt.blocked), false);
});
