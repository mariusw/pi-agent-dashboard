import { describe, it, expect } from "vitest";
import { wireEvents, type EventWiringDeps } from "../event-wiring.js";

/**
 * Regression test for the onEventPersisted replay-gating bug.
 *
 * The hook is meant for real-time consumers (e.g. the Ratatoskr pi-bridge).
 * It must fire only for LIVE events, never for the historical events replayed
 * during session register / reconnect. Otherwise a real-time consumer would
 * republish old events as new on every reconnect.
 *
 * `wireEvents` installs its event handler on `piGateway.onEvent`, so the test
 * drives the public message stream (session_register / event_forward /
 * replay_complete) directly and spies on the injected `onEventPersisted` dep.
 */

type OnEvent = (sessionId: string, msg: any) => void;

function makeHarness(): { onEvent: OnEvent; fired: Array<{ sessionId: string; event: unknown }> } {
  const fired: Array<{ sessionId: string; event: unknown }> = [];

  const piGateway: any = {
    isSessionConnected: () => false,
    getConnectedSessionIds: () => [],
    sendToSession: () => {},
  };
  const sessionManager: any = {
    get: () => undefined,
    update: () => {},
    listAll: () => [],
    listActive: () => [],
    register: () => {},
    unregister: () => {},
  };
  let seq = 0;
  const eventStore: any = {
    insertEvent: () => ++seq,
    getEvent: () => undefined,
    getEvents: () => [],
    deleteEventsForSession: () => {},
    hasEvents: () => false,
  };
  const browserGateway: any = {
    broadcastEvent: () => {},
    broadcastSessionUpdated: () => {},
    broadcastSessionAdded: () => {},
    broadcastSessionRemoved: () => {},
    broadcastSessionStateReset: () => {},
    broadcastToAll: () => {},
    sendToSubscribers: () => {},
    headlessPidRegistry: {
      linkSession: () => {},
      linkByToken: () => false,
      linkByPid: () => false,
    },
    pendingResumeRegistry: { consume: () => undefined },
  };
  const sessionOrderManager: any = { insert: () => {}, getOrder: () => [] };
  const preferencesStore: any = { getPinnedDirectories: () => [] };
  const directoryService: any = {
    onDirectoryAdded: () => Promise.resolve({ sessions: [], openspecData: {} }),
  };
  const pendingForkRegistry: any = { consumeFork: () => undefined };

  const deps = {
    sessionManager,
    eventStore,
    piGateway,
    browserGateway,
    sessionOrderManager,
    preferencesStore,
    pendingForkRegistry,
    directoryService,
    knownSessionIds: new Set<string>(),
    pendingDashboardSpawns: new Map<string, number>(),
    onEventPersisted: (sessionId: string, event: unknown) => {
      fired.push({ sessionId, event });
    },
  } as unknown as EventWiringDeps;

  wireEvents(deps);

  return { onEvent: piGateway.onEvent as OnEvent, fired };
}

function register(onEvent: OnEvent, sessionId: string): void {
  onEvent(sessionId, { type: "session_register", sessionId, cwd: "/tmp", source: "cli" });
}

function replayComplete(onEvent: OnEvent, sessionId: string): void {
  onEvent(sessionId, { type: "replay_complete", sessionId });
}

function forwardEvent(onEvent: OnEvent, sessionId: string): void {
  onEvent(sessionId, {
    type: "event_forward",
    sessionId,
    event: { eventType: "agent_message", timestamp: Date.now(), data: {} },
  });
}

describe("onEventPersisted — replay gating", () => {
  it("fires for a live event (after replay_complete)", () => {
    const { onEvent, fired } = makeHarness();

    register(onEvent, "s-live");
    replayComplete(onEvent, "s-live");
    forwardEvent(onEvent, "s-live");

    expect(fired).toHaveLength(1);
    expect(fired[0]!.sessionId).toBe("s-live");
  });

  it("does NOT fire for an event during replay (before replay_complete)", () => {
    const { onEvent, fired } = makeHarness();

    register(onEvent, "s-replay");
    // Intentionally NO replay_complete — the session is mid-replay.
    forwardEvent(onEvent, "s-replay");

    expect(fired).toHaveLength(0);
  });
});
