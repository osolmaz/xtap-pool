// Bounded live validation of the enrichment worker against the real
// Inference Providers router (GLM 5.2) using real pool tweets, with a
// no-op dataset mirror so nothing is written anywhere durable.
//
//   HF_TOKEN=... node scripts/validate-enrichment-live.mjs [maxUnits]

import { TweetStore } from "../space/dist/src/store.js";
import { EnrichStore, ensureEnrichmentTables } from "../space/dist/src/enrich-store.js";
import { DEFAULT_TAXONOMY } from "../space/dist/src/enrich-config.js";
import { createRouterLlmClient, runEnrichTick } from "../space/dist/src/enrich-worker.js";

const token = process.env.HF_TOKEN;
if (!token) {
  console.error("HF_TOKEN required");
  process.exit(1);
}
const maxUnits = Number(process.argv[2] ?? "40");
if (!Number.isInteger(maxUnits) || maxUnits < 1 || maxUnits > 200) {
  console.error("maxUnits must be an integer between 1 and 200");
  process.exit(1);
}

async function fetchPoolSample() {
  const headers = { authorization: `Bearer ${token}` };
  const list = await fetch(
    "https://huggingface.co/api/datasets/osolmaz/xtap-pool-data/tree/main/data/osolmaz/2026/07",
    { headers },
  ).then((response) => response.json());
  const files = list
    .filter((entry) => entry.path.endsWith(".jsonl"))
    .map((entry) => entry.path)
    .sort()
    .slice(-2);
  const tweets = [];
  for (const file of files) {
    const body = await fetch(
      `https://huggingface.co/datasets/osolmaz/xtap-pool-data/resolve/main/${file}`,
      { headers },
    ).then((response) => response.text());
    for (const line of body.split("\n")) {
      if (line.trim()) tweets.push(JSON.parse(line));
    }
  }
  return tweets;
}

const tweets = await fetchPoolSample();
console.error(`sample: ${tweets.length} pool tweets`);

const store = new TweetStore(":memory:");
ensureEnrichmentTables(store.database);
const enrichStore = new EnrichStore(store.database, 1);
store.insert(tweets);
enrichStore.registerTweets(tweets);

const mirror = {
  commitBatch: async () => {},
  listJsonlFiles: async () => [],
  readFile: async () => undefined,
};

const llm = createRouterLlmClient({ hfToken: token, model: "zai-org/GLM-5.2" });
const receipt = await runEnrichTick({
  enrichStore,
  mirror,
  taxonomy: { labels: [...DEFAULT_TAXONOMY], version: 1 },
  llm,
  model: "zai-org/GLM-5.2",
  maxUnitsPerTick: maxUnits,
  unitsPerCall: 6,
  now: () => new Date(),
});
console.log("receipt:", JSON.stringify(receipt));

const db = store.database;
const labelCounts = db
  .prepare(
    "SELECT name AS label, COUNT(*) AS n FROM label_assignments WHERE kind='preset' GROUP BY name ORDER BY n DESC",
  )
  .all();
console.log("preset label counts:", JSON.stringify(labelCounts));
const freeTop = db
  .prepare(
    `SELECT a.name AS label, COUNT(*) AS n
     FROM label_assignments a
     JOIN free_label_registry r ON r.name = a.name AND r.status = 'approved'
     WHERE a.kind = 'free'
     GROUP BY a.name ORDER BY n DESC LIMIT 10`,
  )
  .all();
console.log("top free labels:", JSON.stringify(freeTop));
const approvedFreeLabels = db
  .prepare(
    "SELECT name, status FROM free_label_registry WHERE status = 'approved' ORDER BY name LIMIT 12",
  )
  .all();
console.log("approved free labels:", JSON.stringify(approvedFreeLabels, null, 1));

const queueSample = db
  .prepare(
    "SELECT status, attempts, last_error, COUNT(*) AS n FROM enrich_queue GROUP BY status, last_error LIMIT 5",
  )
  .all();
console.log("queue:", JSON.stringify(queueSample, null, 1).slice(0, 800));
