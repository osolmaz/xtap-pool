import { join } from "node:path";

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createHubClient, DatasetMirror } from "./dataset.js";
import { loadEnrichTaxonomy } from "./enrich-config.js";
import { EnrichStore } from "./enrich-store.js";
import { createRouterLlmClient, runEnrichTick, startEnrichWorker } from "./enrich-worker.js";
import { ingestBatch, Mutex } from "./ingest.js";
import { PoolMembership } from "./membership.js";
import { TweetStore } from "./store.js";

const config = loadConfig(process.env);
const store = new TweetStore();
const enrichStore = new EnrichStore(store.database, config.taxonomyVersion);
const hub = createHubClient(config.datasetRepo, config.hfToken);
const mirror = new DatasetMirror(hub, join(config.dataDir, "mirror"));
const mutex = new Mutex();
const membership = await PoolMembership.load({
  mirror,
  bootstrapMembers: config.allowedUsers,
  bootstrapAdmins: config.poolAdmins,
  now: () => new Date(),
});
const taxonomy = await loadEnrichTaxonomy(mirror, config.taxonomyVersion);

const workerDeps = {
  enrichStore,
  mirror,
  taxonomy,
  llm: createRouterLlmClient({ hfToken: config.hfToken, model: config.llmModel }),
  model: config.llmModel,
  maxUnitsPerTick: config.enrichMaxUnitsPerTick,
  now: (): Date => new Date(),
};
const drainOnce = (): ReturnType<typeof runEnrichTick> =>
  mutex.run(() => runEnrichTick(workerDeps));

const app = createApp({
  config,
  store,
  membership,
  enrich: { store: enrichStore, taxonomy, run: drainOnce },
  ingest: (username, payload) =>
    mutex.run(() =>
      ingestBatch({ store, mirror, enrich: enrichStore, now: () => new Date() }, username, payload),
    ),
});

// Explorer static assets; API and OAuth routes are registered first and win.
app.use("*", serveStatic({ root: config.staticRoot }));
app.use("*", serveStatic({ root: config.staticRoot, path: "index.html" }));

console.log(`[xtap-pool] rebuilding index from ${config.datasetRepo} ...`);
const rebuilt = await mirror.rebuild(store, enrichStore);
const enrichment = await mirror.rebuildEnrichment(enrichStore);
const pool = membership.snapshot();
console.log(
  `[xtap-pool] indexed ${String(rebuilt.tweets)} tweets from ${String(rebuilt.files)} files; ` +
    `${String(enrichment.rows)} enrichment rows from ${String(enrichment.files)} files ` +
    `(taxonomy v${String(config.taxonomyVersion)}, ${taxonomy.source}); ` +
    `${String(pool.members.length)} pool members, ${String(pool.admins.length)} admins`,
);

if (config.enrichEnabled) {
  startEnrichWorker({ intervalMs: config.enrichIntervalMs, run: drainOnce });
  console.log(
    `[xtap-pool] enrich worker on: every ${String(config.enrichIntervalMs)}ms, ` +
      `up to ${String(config.enrichMaxUnitsPerTick)} units via ${config.llmModel}`,
  );
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[xtap-pool] listening on :${String(info.port)}`);
});
