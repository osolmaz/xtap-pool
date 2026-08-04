import { join } from "node:path";

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";

import { createApp } from "./app.js";
import type { AppReadiness } from "./app.js";
import { loadConfig } from "./config.js";
import { createHubClient, DatasetMirror } from "./dataset.js";
import type { DatasetState } from "./dataset-state.js";
import { checkDatasetCredential, datasetCredentialOk } from "./dataset-token.js";
import type { DatasetCredentialReadiness } from "./dataset-token.js";
import { loadEnrichTaxonomy } from "./enrich-config.js";
import { DurableIndex } from "./durable-index.js";
import { contractHashFor } from "./enrich-worker.js";
import { ingestBatch, Mutex } from "./ingest.js";
import { checkInferenceCredential, inferenceCredentialOk } from "./inference-token.js";
import type { InferenceCredentialReadiness } from "./inference-token.js";
import { PoolMembership } from "./membership.js";
import { ServiceAccountRegistry } from "./service-accounts.js";
import { UnitStore } from "./unit-store.js";

const config = loadConfig(process.env);
const hub = createHubClient(config.datasetRepo, config.hfToken);
const mirror = new DatasetMirror(hub, join(config.dataDir, "mirror"));
const mutex = new Mutex();

type RebuildStats = { files: number; tweets: number };
type EnrichmentStats = { files: number; rows: number };

let rebuilt: RebuildStats = { files: 0, tweets: 0 };
let enrichment: EnrichmentStats = { files: 0, rows: 0 };
let datasetState: DatasetState = {
  state: "unknown",
  error: "The durable dataset index has not been restored yet.",
};
let datasetCredential: DatasetCredentialReadiness = {
  credential: "unknown",
  error: "HF_TOKEN has not been checked yet.",
};
let inferenceCredential: InferenceCredentialReadiness = config.enrichEnabled
  ? { credential: "missing", error: "INFERENCE_TOKEN has not been checked yet." }
  : { credential: "not_required" };
let readiness: AppReadiness;
let credentialRetryTimer: ReturnType<typeof setTimeout> | undefined;
let enrichmentRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let activeFetch: (request: Request) => Response | Promise<Response> = () =>
  Response.json(
    {
      ok: false,
      dataset: {
        credential: datasetCredential.credential,
        state: datasetCredential.credential === "invalid" ? "invalid" : "unknown",
        indexed_files: 0,
        indexed_tweets: 0,
        enrichment_rows: 0,
        ...(datasetCredential.credential === "ok"
          ? {}
          : { credential_error: datasetCredential.error }),
        error: datasetState.state === "ready" ? undefined : datasetState.error,
      },
    },
    { status: 503 },
  );
serve({ fetch: (request: Request) => activeFetch(request), port: config.port }, (info) => {
  console.log(`[xtap-pool] listening on :${String(info.port)}`);
});

[datasetCredential, inferenceCredential] = await Promise.all([
  checkDatasetCredential({
    token: config.hfToken,
    datasetRepo: config.datasetRepo,
    indexBucket: config.indexBucket,
  }),
  checkInferenceCredential({
    enabled: config.enrichEnabled,
    token: config.inferenceToken,
  }),
]);
await waitForStorageCredential();

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
if (taxonomy.error !== undefined) {
  throw new Error(`enrichment taxonomy unavailable: ${taxonomy.error}`);
}
const contractHash = contractHashFor({ taxonomy, model: config.llmModel });
const index = await DurableIndex.restore({
  datasetRepo: config.datasetRepo,
  indexBucket: config.indexBucket,
  accessToken: config.hfToken,
  databasePath: join(config.dataDir, "index", "space.sqlite"),
  mirror,
  taxonomyVersion: config.taxonomyVersion,
  contractHash,
});
const initialAdvance = await index.advanceToLatest();
const store = index.store;
const enrichStore = index.enrichStore;
const unitStore = new UnitStore(store.database, config.taxonomyVersion);
let lastReceipt: import("@xtap-pool/shared").EnrichReceipt | undefined;
function recordLastReceipt(receipt: import("@xtap-pool/shared").EnrichReceipt | undefined): void {
  if (receipt?.contract_hash !== enrichStore.currentContractHash()) return;
  if (lastReceipt === undefined || receipt.finished_at > lastReceipt.finished_at) {
    lastReceipt = receipt;
  }
}
applyIndexStats();
datasetState = { state: "ready" };
enrichStore.releaseClaims();
readiness = buildReadiness();
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
    lastReceipt: () => lastReceipt,
  },
  ingest: (username, payload) =>
    mutex.run(async () => {
      const result = await ingestBatch(
        { store, mirror, enrich: enrichStore, now: () => new Date() },
        username,
        payload,
      );
      try {
        await index.advanceToLatest();
        applyIndexStats();
        datasetState = { state: "ready" };
        readiness = buildReadiness();
      } catch (error) {
        const message = errorMessage(error);
        datasetState = { state: "invalid", error: `durable index ingest sync failed: ${message}` };
        readiness = buildReadiness();
        throw error;
      }
      return result;
    }),
  repairMembership: (actor) =>
    mutex.run(async () => {
      const pool = await membership.repairConfig(actor);
      readiness = buildReadiness();
      return pool;
    }),
  mutateServiceAccounts: (operation) =>
    mutex.run(async () => {
      const result = await operation();
      readiness = buildReadiness();
      return result;
    }),
  readiness: () => readiness,
});

// Explorer static assets; API and OAuth routes are registered first and win.
app.use("*", serveStatic({ root: config.staticRoot }));
app.use("*", serveStatic({ root: config.staticRoot, path: "index.html" }));

console.log(
  `[xtap-pool] restored durable index ${initialAdvance.revision.slice(0, 12)} from ` +
    `${config.indexBucket}; changed_files=${String(initialAdvance.filesChanged)} ` +
    `rows=${String(initialAdvance.rowsApplied)}`,
);
readiness = buildReadiness();
const pool = membership.snapshot();
console.log(
  `[xtap-pool] indexed ${String(rebuilt.tweets)} tweets from ${String(rebuilt.files)} files; ` +
    `${String(enrichment.rows)} enrichment rows from ${String(enrichment.files)} files ` +
    `(taxonomy v${String(config.taxonomyVersion)}, ${taxonomy.source}); ` +
    `${String(pool.members.length)} pool members, ${String(pool.admins.length)} admins`,
);

if (config.enrichEnabled && !inferenceCredentialOk(inferenceCredential)) {
  console.error(
    `[xtap-pool] enrich configuration warning: ${readiness.enrichment.error ?? "invalid credential"}`,
  );
}
if (config.enrichEnabled) {
  console.log(
    "[xtap-pool] enrichment scheduling is external: run `npm run enrich --workspace space` " +
      "to drain the queue.",
  );
}
activeFetch = (request) => app.fetch(request);
startCredentialRetryIfNeeded();
startEnrichmentRefresh();

function applyIndexStats(): void {
  const stats = index.stats();
  rebuilt = { files: stats.tweetFiles, tweets: stats.tweetRows };
  enrichment = { files: stats.enrichmentFiles, rows: stats.enrichmentRows };
  recordLastReceipt(mirror.latestReceipt());
}

/**
 * The enrichment worker is intentionally external. This reader loop only
 * replays recently changed durable shards so a long-running Space observes
 * scheduled-worker commits without starting a provider client or worker.
 */
function startEnrichmentRefresh(): void {
  if (enrichmentRefreshTimer !== undefined) return;
  enrichmentRefreshTimer = setTimeout(() => {
    enrichmentRefreshTimer = undefined;
    void refreshExternalEnrichment()
      .catch((error: unknown) => {
        const message = errorMessage(error);
        datasetState = { state: "invalid", error: `durable index refresh failed: ${message}` };
        readiness = buildReadiness();
        console.error(`[xtap-pool] enrichment refresh failed: ${message}`);
      })
      .finally(startEnrichmentRefresh);
  }, enrichmentRefreshMs());
}

async function refreshExternalEnrichment(): Promise<void> {
  if (!datasetCredentialOk(datasetCredential)) return;
  await mutex.run(async () => {
    if (!datasetCredentialOk(datasetCredential)) return;
    const nextTaxonomy = await loadEnrichTaxonomy(mirror, config.taxonomyVersion);
    if (nextTaxonomy.error !== undefined) {
      throw new Error(`enrichment taxonomy refresh failed: ${nextTaxonomy.error}`);
    }
    const nextContractHash = contractHashFor({ taxonomy: nextTaxonomy, model: config.llmModel });
    if (nextContractHash !== enrichStore.currentContractHash()) {
      throw new Error("enrichment contract changed; publish a replacement durable index");
    }
    taxonomy = nextTaxonomy;
    await index.advanceToLatest();
    applyIndexStats();
    datasetState = { state: "ready" };
    readiness = buildReadiness();
  });
}

function enrichmentRefreshMs(): number {
  return Math.min(Math.max(config.enrichIntervalMs, 5000), 60000);
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

// eslint-disable-next-line complexity -- Recovery checks each independently persisted dataset-backed configuration.
async function reloadDatasetBackedConfig(force: boolean): Promise<void> {
  if (force || membership.hasRetryableConfigError()) await membership.reload();
  if (force || serviceAccounts.hasRetryableConfigError()) await serviceAccounts.reload();
  if (config.enrichEnabled && (force || !taxonomyReady())) {
    const nextTaxonomy = await loadEnrichTaxonomy(mirror, config.taxonomyVersion);
    const nextContractHash = contractHashFor({ taxonomy: nextTaxonomy, model: config.llmModel });
    if (nextContractHash !== enrichStore.currentContractHash()) {
      throw new Error("enrichment contract changed; publish a replacement durable index");
    }
    taxonomy = nextTaxonomy;
  }
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
      indexBucket: config.indexBucket,
    });
  }
  const datasetRecovered = !datasetWasReady && datasetCredentialOk(datasetCredential);
  if (datasetRecovered || needsDatasetConfigRetry()) {
    await mutex.run(async () => {
      await reloadDatasetBackedConfig(datasetRecovered);
      if (datasetRecovered || datasetState.state === "unknown") {
        await index.advanceToLatest();
        applyIndexStats();
        datasetState = { state: "ready" };
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
}

async function waitForStorageCredential(): Promise<void> {
  while (!datasetCredentialOk(datasetCredential)) {
    datasetState = {
      state: datasetCredential.credential === "invalid" ? "invalid" : "unknown",
      error: "error" in datasetCredential ? datasetCredential.error : "HF_TOKEN is unavailable.",
    };
    console.error(`[xtap-pool] storage credential unavailable: ${datasetState.error}`);
    await new Promise((resolve) => setTimeout(resolve, credentialRetryMs()));
    datasetCredential = await checkDatasetCredential({
      token: config.hfToken,
      datasetRepo: config.datasetRepo,
      indexBucket: config.indexBucket,
    });
  }
}

function credentialRetryMs(): number {
  return Math.min(Math.max(config.enrichIntervalMs, 5000), 60000);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
