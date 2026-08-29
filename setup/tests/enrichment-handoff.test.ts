import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureCommand: vi.fn(),
  assertWritersQuiescent: vi.fn(),
}));

vi.mock("../src/process.js", () => ({ captureCommand: mocks.captureCommand }));
vi.mock("../src/enrichment-job.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/enrichment-job.js")>();
  return { ...actual, assertEnrichmentWritersQuiescent: mocks.assertWritersQuiescent };
});

import {
  createEnrichmentDeploymentManifestPreparer,
  productionEnrichmentHandoffPreparation,
  type EnrichmentHandoffPreparation,
} from "../src/enrichment-handoff.js";

const TARGET = "a".repeat(40);
const PREDECESSOR = "b".repeat(40);

function handoff() {
  return {
    active_generation: 29,
    activation_sha256: "1".repeat(64),
    run_id: "xtap-1321e3a40c38f32c0c210d8859622379",
    plan_sha256: "2".repeat(64),
    plan_worker_revision: PREDECESSOR,
    target_worker_revision: TARGET,
    contract_sha256: "3".repeat(64),
    source_snapshot_revision: "4".repeat(64),
    checkpoint_pointer_sha256: "5".repeat(64),
    checkpoint_sequence: 807,
    checkpoint_key: "operations/enrichment/runs/run/checkpoints/checkpoint.hfjob",
    checkpoint_sha256: "6".repeat(64),
    checkpoint_bytes: 123,
  };
}

function preparation(overrides: Partial<EnrichmentHandoffPreparation> = {}) {
  const events: string[] = [];
  const value: EnrichmentHandoffPreparation = {
    assertClean: vi.fn(() => {
      events.push("clean");
      return Promise.resolve();
    }),
    readHead: vi.fn(() => {
      events.push("head");
      return Promise.resolve(TARGET);
    }),
    assertWritersQuiescent: vi.fn(() => {
      events.push("writers");
      return Promise.resolve("schedule-hash");
    }),
    prepareHandoff: vi.fn(() => {
      events.push("handoff");
      return Promise.resolve(handoff());
    }),
    ...overrides,
  };
  return { events, value };
}

describe("enrichment deployment handoff preparation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("uses the clean local revision, read-only verifier, and canonical writer fence", async () => {
    mocks.captureCommand.mockImplementation(
      (command: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
        if (command === "git" && args[0] === "rev-parse") {
          return Promise.resolve({ stdout: `${TARGET}\n`, stderr: "" });
        }
        if (command === "git" && args[0] === "status") {
          return Promise.resolve({ stdout: "", stderr: "" });
        }
        if (command === "npm") {
          expect(args).toEqual([
            "run",
            "--silent",
            "enrich:prepare-handoff",
            "--workspace",
            "space",
          ]);
          expect(options?.env).toMatchObject({
            RAW_BUCKET: "alice/raw",
            INDEX_BUCKET: "alice/index",
            HF_TOKEN: "storage-token",
            XTAP_TARGET_SOURCE_REVISION: TARGET,
            INFERENCE_TOKEN: undefined,
          });
          return Promise.resolve({ stdout: JSON.stringify(handoff()), stderr: "" });
        }
        return Promise.reject(new Error("unexpected command"));
      },
    );
    mocks.assertWritersQuiescent.mockResolvedValue("schedule-hash");
    const production = productionEnrichmentHandoffPreparation({
      root: "/repo",
      client: { accessToken: "owner" },
      config: {
        namespace: "alice",
        spaceRepo: "alice/xtap-pool",
        rawBucket: "alice/raw",
        indexBucket: "alice/index",
        allowedUsers: ["alice"],
        poolAdmins: ["alice"],
      },
      variables: new Map(),
      storageToken: "storage-token",
    });

    await expect(production.readHead()).resolves.toBe(TARGET);
    await expect(production.assertClean()).resolves.toBeUndefined();
    await expect(production.assertWritersQuiescent()).resolves.toBe("schedule-hash");
    await expect(production.prepareHandoff(TARGET)).resolves.toEqual(handoff());
    mocks.captureCommand.mockResolvedValueOnce({ stdout: "null", stderr: "" });
    await expect(production.prepareHandoff(TARGET)).resolves.toBeNull();
  });

  it("rejects a dirty deployment tree and malformed verifier output", async () => {
    mocks.captureCommand.mockResolvedValueOnce({ stdout: " M file.ts\n", stderr: "" });
    const production = productionEnrichmentHandoffPreparation({
      root: "/repo",
      client: { accessToken: "owner" },
      config: {
        namespace: "alice",
        spaceRepo: "alice/xtap-pool",
        rawBucket: "alice/raw",
        indexBucket: "alice/index",
        allowedUsers: ["alice"],
        poolAdmins: ["alice"],
      },
      variables: new Map(),
      storageToken: "storage-token",
    });
    await expect(production.assertClean()).rejects.toThrow("clean Git worktree");

    mocks.captureCommand.mockResolvedValueOnce({ stdout: "{}", stderr: "" });
    await expect(production.prepareHandoff(TARGET)).rejects.toThrow();
  });

  it("prepares and revalidates Git and writer exclusion before staging", async () => {
    const fixture = preparation();
    const prepareManifest = createEnrichmentDeploymentManifestPreparer(fixture.value);

    await expect(prepareManifest()).resolves.toEqual({
      source_revision: TARGET,
      enrichment_revision_handoff: handoff(),
    });
    expect(fixture.events).toEqual([
      "clean",
      "head",
      "writers",
      "handoff",
      "writers",
      "clean",
      "head",
    ]);
  });

  it("fails closed when Git or the canonical schedule changes", async () => {
    const changingHead = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce(TARGET)
      .mockResolvedValueOnce("c".repeat(40));
    const headFixture = preparation({ readHead: changingHead });
    await expect(createEnrichmentDeploymentManifestPreparer(headFixture.value)()).rejects.toThrow(
      "Git revision changed",
    );

    const changingWriters = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("before")
      .mockResolvedValueOnce("after");
    const writerFixture = preparation({ assertWritersQuiescent: changingWriters });
    await expect(createEnrichmentDeploymentManifestPreparer(writerFixture.value)()).rejects.toThrow(
      "schedule changed",
    );
  });

  it("rejects malformed or secret-bearing handoff output", async () => {
    const fixture = preparation({
      prepareHandoff: vi.fn(() => Promise.resolve({ ...handoff(), secret: "must-not-pass" })),
    });
    await expect(createEnrichmentDeploymentManifestPreparer(fixture.value)()).rejects.toThrow();
  });
});
