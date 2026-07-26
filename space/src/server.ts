import { join } from "node:path";

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";

import { createApp } from "./app.js";
import type { AppReadiness } from "./app.js";
import { loadConfig } from "./config.js";
import { createHubClient, DatasetMirror } from "./dataset.js";
import { datasetStateFromRebuildError, errorStatus } from "./dataset-state.js";
import type { DatasetState } from "./dataset-state.js";
import { checkDatasetCredential, datasetCredentialOk } from "./dataset-token.js";
import type { DatasetCredentialReadiness } from "./dataset-token.js";
import { loadEnrichTaxonomy } from "./enrich-config.js";
import { EnrichStore } from "./enrich-store.js";
import { createRouterLlmClient, runEnrichTick, startEnrichWorker } from "./enrich-worker.js";
import { ingestBatch, Mutex } from "./ingest.js";
import { checkInferenceCredential, inferenceCredentialOk } from "./inference-token.js";
import type { InferenceCredentialReadiness } from "./inference-token.js";
import { PoolMembership } from "./membership.js";
import { ServiceAccountRegistry } from "./service-accounts.js";
import { TweetStore } from "./store.js";
import { UnitStore } from "./unit-store.js";

const config = loadConfig(process.env);
const store = new TweetStore();
const enrichStore = new EnrichStore(store.database, config.taxonomyVersion);
const unitStore = new UnitStore(store.database, config.taxonomyVersion);
const hub = createHubClient(config.datasetRepo, config.hfToken);
const mirror = new DatasetMirror(hub, join(config.dataDir, "mirror"));
const mutex = new Mutex();

type RebuildStats = { files: number; tweets: number };
type EnrichmentStats = { files: number; rows: number };

let rebuilt: RebuildStats = { files: 0, tweets: 0 };
let enrichment: EnrichmentStats = { files: 0, rows: 0 };
let datasetState: DatasetState = {
  state: "unknown",
  error: "The dataset index has not been built yet.",
};
let datasetCredential: DatasetCredentialReadiness = {
  credential: "unknown",
  error: "HF_TOKEN has not been checked yet.",
};
let inferenceCredential: InferenceCredentialReadiness = config.enrichEnabled
  ? { credential: "missing", error: "INFERENCE_TOKEN has not been checked yet." }
  : { credential: "not_required" };
let readiness: AppReadiness;
let enrichWorker: { stop: () => void } | undefined;
let credentialRetryTimer: ReturnType<typeof setTimeout> | undefined;

[datasetCredential, inferenceCredential] = await Promise.all([
  checkDatasetCredential({ token: config.hfToken, datasetRepo: config.datasetRepo }),
  checkInferenceCredential({
    enabled: config.enrichEnabled,
    token: config.inferenceToken,
  }),
]);

const [membership, serviceAccounts] = await Promise.all([
  PoolMembership.load({
    mirror,
    bootstrapMembers: config.allowedUsers,
    bootstrapAdmins: config.poolAdmins,
    now: () => new Date(),
  }),
  ServiceAccountRegistry.load({ mirror, now: () => new Date() }),
]);
let taxonomy = await loadEnrichTaxonomy(mirror, config.taxonomyVersion);
readiness = buildReadiness();
const drainOnce = createEnrichmentDrain();

const app = createApp({
  config,
  store,
  membership,
  serviceAccounts,
  unitStore,
  enrich: {
    store: enrichStore,
    get taxonomy() {
      return taxonomy;
    },
    run: drainOnce,
  },
  ingest: (username, payload) =>
    mutex.run(() =>
      ingestBatch({ store, mirror, enrich: enrichStore, now: () => new Date() }, username, payload),
    ),
  repairMembership: (actor) =>
    mutex.run(async () => {
      const pool = await membership.repairConfig(actor);
      readiness = buildReadiness();
      startEnrichWorkerIfReady();
      return pool;
    }),
  mutateServiceAccounts: (operation) =>
    mutex.run(async () => {
      const result = await operation();
      readiness = buildReadiness();
      startEnrichWorkerIfReady();
      return result;
    }),
  readiness: () => readiness,
});

// Explorer static assets; API and OAuth routes are registered first and win.
app.use("*", serveStatic({ root: config.staticRoot }));
app.use("*", serveStatic({ root: config.staticRoot, path: "index.html" }));

console.log(`[xtap-pool] rebuilding index from ${config.datasetRepo} ...`);
await rebuildDatasetIndexIfReady();
readiness = buildReadiness();
const pool = membership.snapshot();
console.log(
  `[xtap-pool] indexed ${String(rebuilt.tweets)} tweets from ${String(rebuilt.files)} files; ` +
    `${String(enrichment.rows)} enrichment rows from ${String(enrichment.files)} files ` +
    `(taxonomy v${String(config.taxonomyVersion)}, ${taxonomy.source}); ` +
    `${String(pool.members.length)} pool members, ${String(pool.admins.length)} admins`,
);

startEnrichWorkerIfReady();
if (config.enrichEnabled && !inferenceCredentialOk(inferenceCredential)) {
  console.error(
    `[xtap-pool] enrich worker off: ${readiness.enrichment.error ?? "invalid credential"}`,
  );
}
startCredentialRetryIfNeeded();

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[xtap-pool] listening on :${String(info.port)}`);
});

function createEnrichmentDrain(): () => ReturnType<typeof runEnrichTick> {
  if (config.inferenceToken === undefined) {
    return () => Promise.reject(new Error("INFERENCE_TOKEN is required to run enrichment."));
  }
  const llm = createRouterLlmClient({ hfToken: config.inferenceToken, model: config.llmModel });
  return () => {
    if (!datasetCredentialOk(datasetCredential)) {
      return Promise.reject(new Error("HF_TOKEN must be ready before enrichment can run."));
    }
    if (!inferenceCredentialOk(inferenceCredential)) {
      return Promise.reject(new Error("INFERENCE_TOKEN must be ready before enrichment can run."));
    }
    if (
      datasetState.state !== "ready" ||
      membership.hasConfigError() ||
      serviceAccounts.hasConfigError()
    ) {
      return Promise.reject(new Error("The dataset must be ready before enrichment can run."));
    }
    if (!taxonomyReady()) {
      return Promise.reject(
        new Error(`enrichment taxonomy is unavailable: ${taxonomy.error ?? "unknown error"}`),
      );
    }
    return runEnrichTick({
      enrichStore,
      mirror,
      taxonomy,
      llm,
      model: config.llmModel,
      maxUnitsPerTick: config.enrichMaxUnitsPerTick,
      now: (): Date => new Date(),
      lock: <T>(fn: () => Promise<T>): Promise<T> => mutex.run(fn),
    });
  };
}

async function rebuildDatasetIndexIfReady(): Promise<void> {
  if (!datasetCredentialOk(datasetCredential)) return;
  datasetState = { state: "unknown", error: "Rebuilding the dataset index." };
  readiness = buildReadiness();
  mirror.clearForRebuild();
  enrichStore.clearForRebuild();
  store.clearForRebuild();
  rebuilt = { files: 0, tweets: 0 };
  enrichment = { files: 0, rows: 0 };
  try {
    rebuilt = await mirror.rebuild(store, enrichStore);
    enrichment = await mirror.rebuildEnrichment(enrichStore);
    enrichStore.releaseClaims();
    datasetState = { state: "ready" };
  } catch (error) {
    const status = errorStatus(error);
    if (status === 401 || status === 403) {
      datasetCredential = { credential: "invalid", error: errorMessage(error) };
      datasetState = { state: "unknown", error: "Dataset indexing requires a valid HF_TOKEN." };
    } else {
      datasetState = datasetStateFromRebuildError(error);
    }
  }
}

function buildReadiness(): AppReadiness {
  return {
    ok: poolReady(),
    dataset: buildDatasetReadiness(),
    enrichment: buildEnrichmentReadiness(),
    service_accounts: buildServiceAccountReadiness(),
  };
}

function poolReady(): boolean {
  const configReady = !membership.hasConfigError() && !serviceAccounts.hasConfigError();
  const enrichmentReady = !config.enrichEnabled || taxonomyReady();
  return (
    datasetRuntimeReady() &&
    configReady &&
    inferenceCredentialOk(inferenceCredential) &&
    enrichmentReady
  );
}

function datasetRuntimeReady(): boolean {
  const indexReady = rebuilt.tweets > 0 || rebuilt.files === 0;
  return indexReady && datasetCredentialOk(datasetCredential) && datasetState.state === "ready";
}

function buildServiceAccountReadiness(): NonNullable<AppReadiness["service_accounts"]> {
  const snapshot = serviceAccounts.snapshot();
  const error = snapshot.config_error;
  const state =
    error === undefined
      ? "ready"
      : serviceAccounts.hasRetryableConfigError()
        ? "unknown"
        : "invalid";
  return {
    state,
    accounts: snapshot.accounts.length,
    ...(error === undefined ? {} : { error }),
  };
}

function buildDatasetReadiness(): AppReadiness["dataset"] {
  const credentialError = "error" in datasetCredential ? datasetCredential.error : undefined;
  const configError = membership.snapshot().config_error;
  const error =
    configError === undefined ? datasetStateError() : `pool config is unavailable: ${configError}`;
  return {
    indexed_files: rebuilt.files,
    indexed_tweets: rebuilt.tweets,
    enrichment_rows: enrichment.rows,
    credential: datasetCredential.credential,
    ...(credentialError === undefined ? {} : { credential_error: credentialError }),
    state: configError === undefined ? datasetState.state : "invalid",
    ...(error === undefined ? {} : { error }),
  };
}

function buildEnrichmentReadiness(): AppReadiness["enrichment"] {
  const credentialError = "error" in inferenceCredential ? inferenceCredential.error : undefined;
  const taxonomyError = taxonomy.error;
  const state = !config.enrichEnabled
    ? "disabled"
    : taxonomyError === undefined
      ? "ready"
      : "unknown";
  return {
    enabled: config.enrichEnabled,
    model: config.llmModel,
    credential: inferenceCredential.credential,
    ...(credentialError === undefined ? {} : { credential_error: credentialError }),
    state,
    ...(taxonomyError === undefined
      ? {}
      : { error: `enrichment taxonomy is unavailable: ${taxonomyError}` }),
  };
}

function datasetStateError(): string | undefined {
  return datasetState.state === "ready" ? undefined : datasetState.error;
}

function taxonomyReady(): boolean {
  return taxonomy.error === undefined;
}

async function reloadDatasetBackedConfig(force: boolean): Promise<void> {
  if (force || membership.hasRetryableConfigError()) await membership.reload();
  if (force || serviceAccounts.hasRetryableConfigError()) await serviceAccounts.reload();
  if (config.enrichEnabled && (force || !taxonomyReady())) {
    taxonomy = await loadEnrichTaxonomy(mirror, config.taxonomyVersion);
  }
}

function enrichmentRuntimeReady(): boolean {
  return (
    config.enrichEnabled &&
    datasetCredentialOk(datasetCredential) &&
    datasetState.state === "ready" &&
    !membership.hasConfigError() &&
    !serviceAccounts.hasConfigError() &&
    inferenceCredentialOk(inferenceCredential) &&
    taxonomyReady()
  );
}

function startEnrichWorkerIfReady(): void {
  if (!enrichmentRuntimeReady() || enrichWorker !== undefined) return;
  enrichWorker = startEnrichWorker({ intervalMs: config.enrichIntervalMs, run: drainOnce });
  console.log(
    `[xtap-pool] enrich worker on: every ${String(config.enrichIntervalMs)}ms, ` +
      `up to ${String(config.enrichMaxUnitsPerTick)} units via ${config.llmModel}`,
  );
}

function startCredentialRetryIfNeeded(): void {
  if (credentialRetryTimer !== undefined || !needsCredentialRetry()) return;
  credentialRetryTimer = setTimeout(() => {
    credentialRetryTimer = undefined;
    void retryUncertainCredentials()
      .catch((error: unknown) => {
        console.error(`[xtap-pool] credential recovery failed: ${errorMessage(error)}`);
      })
      .finally(startCredentialRetryIfNeeded);
  }, credentialRetryMs());
}

function needsCredentialRetry(): boolean {
  return (
    datasetCredential.credential === "unknown" ||
    inferenceCredential.credential === "unknown" ||
    needsDatasetConfigRetry()
  );
}

function needsDatasetConfigRetry(): boolean {
  return (
    datasetCredentialOk(datasetCredential) &&
    (membership.hasRetryableConfigError() ||
      serviceAccounts.hasRetryableConfigError() ||
      datasetState.state === "unknown" ||
      (config.enrichEnabled && !taxonomyReady()))
  );
}

async function retryUncertainCredentials(): Promise<void> {
  const datasetWasReady = datasetCredentialOk(datasetCredential);
  if (datasetCredential.credential === "unknown") {
    datasetCredential = await checkDatasetCredential({
      token: config.hfToken,
      datasetRepo: config.datasetRepo,
    });
  }
  const datasetRecovered = !datasetWasReady && datasetCredentialOk(datasetCredential);
  if (datasetRecovered || needsDatasetConfigRetry()) {
    await mutex.run(async () => {
      await reloadDatasetBackedConfig(datasetRecovered);
      if (datasetRecovered || datasetState.state === "unknown") {
        await rebuildDatasetIndexIfReady();
      }
    });
  }
  if (inferenceCredential.credential === "unknown") {
    inferenceCredential = await checkInferenceCredential({
      enabled: config.enrichEnabled,
      token: config.inferenceToken,
    });
  }
  readiness = buildReadiness();
  startEnrichWorkerIfReady();
}

function credentialRetryMs(): number {
  return Math.min(Math.max(config.enrichIntervalMs, 5000), 60000);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
