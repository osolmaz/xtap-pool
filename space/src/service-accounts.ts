import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { serviceAccountScopeSchema } from "@xtap-pool/shared";
import type {
  IssuedServiceAccountCredential,
  ServiceAccountScope,
  ServiceAccountsSnapshot,
  ServiceAccountSummary,
} from "@xtap-pool/shared";

import type { StorageLog } from "./bucket-log.js";

export const SERVICE_ACCOUNTS_PATH = "config/service-accounts.json";

const ACCOUNT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TOKEN_PREFIX = "xtap_sa";
const KEY_TTL_MS = 365 * 24 * 60 * 60 * 1000;

const timestampSchema = z.iso.datetime();

const serviceAccountKeySchema = z.object({
  id: z.string().min(1),
  token_hash: z.string().regex(/^[a-f0-9]{64}$/),
  created_at: timestampSchema,
  expires_at: timestampSchema.optional(),
});

const serviceAccountSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  scopes: z.array(serviceAccountScopeSchema).min(1),
  status: z.enum(["active", "revoked"]),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  keys: z.array(serviceAccountKeySchema),
});

const serviceAccountsFileSchema = z.object({
  version: z.literal(1),
  accounts: z.array(serviceAccountSchema),
});

type ServiceAccountFile = z.infer<typeof serviceAccountsFileSchema>;
type StoredServiceAccount = ServiceAccountFile["accounts"][number];
type StoredServiceAccountKey = StoredServiceAccount["keys"][number];

type ServiceAccountRegistryOptions = {
  log: StorageLog;
  now: () => Date;
};

type LoadedServiceAccounts = {
  file: ServiceAccountFile;
  source: ServiceAccountsSnapshot["source"];
  configError?: string;
  retryable: boolean;
};

export type ServiceAccountIdentity = {
  id: string;
  name: string;
  keyId: string;
  scopes: readonly ServiceAccountScope[];
};

/** Bucket-backed registry for rotatable, least-privilege machine credentials. */
export class ServiceAccountRegistry {
  private file: ServiceAccountFile;
  private source: ServiceAccountsSnapshot["source"];
  private configError: string | undefined;
  private configErrorRetryable: boolean;
  private mutationTail: Promise<void> = Promise.resolve();

  private constructor(
    private readonly options: ServiceAccountRegistryOptions,
    loaded: LoadedServiceAccounts,
  ) {
    this.file = normalizeFile(loaded.file);
    this.source = loaded.source;
    this.configError = loaded.configError;
    this.configErrorRetryable = loaded.retryable;
  }

  static async load(options: ServiceAccountRegistryOptions): Promise<ServiceAccountRegistry> {
    return new ServiceAccountRegistry(options, await loadFile(options));
  }

  async reload(): Promise<ServiceAccountsSnapshot> {
    return this.enqueueMutation(async () => {
      const loaded = await loadFile(this.options);
      this.file = normalizeFile(loaded.file);
      this.source = loaded.source;
      this.configError = loaded.configError;
      this.configErrorRetryable = loaded.retryable;
      return this.snapshot();
    });
  }

  hasConfigError(): boolean {
    return this.configError !== undefined;
  }

  hasRetryableConfigError(): boolean {
    return this.configError !== undefined && this.configErrorRetryable;
  }

  hasPermanentConfigError(): boolean {
    return this.configError !== undefined && !this.configErrorRetryable;
  }

  snapshot(): ServiceAccountsSnapshot {
    const snapshot: ServiceAccountsSnapshot = {
      version: 1,
      accounts: this.file.accounts.map(toSummary),
      source: this.source,
    };
    if (this.configError !== undefined) snapshot.config_error = this.configError;
    return snapshot;
  }

  authorize(token: string, requiredScope: ServiceAccountScope): ServiceAccountIdentity | undefined {
    const parsed = parseToken(token);
    if (parsed === undefined || this.configError !== undefined) return undefined;
    const account = this.file.accounts.find(
      (candidate) => candidate.id === parsed.accountId && candidate.status === "active",
    );
    if (account?.scopes.includes(requiredScope) !== true) return undefined;
    const key = account.keys.find((candidate) => candidate.id === parsed.keyId);
    if (key === undefined || isExpired(key, this.options.now())) return undefined;
    if (!tokenHashMatches(token, key.token_hash)) return undefined;
    return { id: account.id, name: account.name, keyId: key.id, scopes: account.scopes };
  }

  async issue(
    actor: string,
    name: string,
    scopes: readonly ServiceAccountScope[],
  ): Promise<IssuedServiceAccountCredential> {
    return this.enqueueMutation(async () => {
      this.assertWritable();
      const normalizedName = normalizeName(name);
      if (this.file.accounts.some((account) => account.name === normalizedName)) {
        throw new Error(`service account already exists: ${normalizedName}`);
      }
      const timestamp = this.options.now().toISOString();
      const accountId = randomId(8);
      const issued = issueKey(accountId, timestamp, expiresAt(this.options.now()));
      const account: StoredServiceAccount = {
        id: accountId,
        name: normalizedName,
        scopes: normalizeScopes(scopes),
        status: "active",
        created_at: timestamp,
        updated_at: timestamp,
        keys: [issued.key],
      };
      await this.commit(
        { version: 1, accounts: [...this.file.accounts, account] },
        `config: issue service account ${normalizedName} by ${actor}`,
      );
      return { account: toSummary(account), token: issued.token };
    });
  }

  async rotate(actor: string, accountId: string): Promise<IssuedServiceAccountCredential> {
    return this.enqueueMutation(async () => {
      this.assertWritable();
      const account = this.activeAccount(accountId);
      const timestamp = this.options.now().toISOString();
      const issued = issueKey(account.id, timestamp, expiresAt(this.options.now()));
      const updated = { ...account, updated_at: timestamp, keys: [...account.keys, issued.key] };
      await this.replaceAccount(
        updated,
        `config: rotate service account ${account.name} by ${actor}`,
      );
      return { account: toSummary(updated), token: issued.token };
    });
  }

  async revokeKey(actor: string, accountId: string, keyId: string): Promise<ServiceAccountSummary> {
    return this.enqueueMutation(async () => {
      this.assertWritable();
      const account = this.activeAccount(accountId);
      const keys = account.keys.filter((key) => key.id !== keyId);
      if (keys.length === account.keys.length)
        throw new Error(`unknown service account key: ${keyId}`);
      const updated = { ...account, updated_at: this.options.now().toISOString(), keys };
      await this.replaceAccount(updated, `config: revoke service account key ${keyId} by ${actor}`);
      return toSummary(updated);
    });
  }

  async revoke(actor: string, accountId: string): Promise<ServiceAccountSummary> {
    return this.enqueueMutation(async () => {
      this.assertWritable();
      const account = this.file.accounts.find((candidate) => candidate.id === accountId);
      if (account === undefined) throw new Error(`unknown service account: ${accountId}`);
      if (account.status === "revoked") return toSummary(account);
      const updated: StoredServiceAccount = {
        ...account,
        status: "revoked",
        updated_at: this.options.now().toISOString(),
        keys: [],
      };
      await this.replaceAccount(
        updated,
        `config: revoke service account ${account.name} by ${actor}`,
      );
      return toSummary(updated);
    });
  }

  /** Replace a malformed durable registry with an empty, deny-by-default registry. */
  async repair(actor: string): Promise<ServiceAccountsSnapshot> {
    return this.enqueueMutation(async () => {
      if (!this.hasPermanentConfigError()) {
        throw new Error("service account config does not have a repairable validation error");
      }
      await this.commit(emptyFile(), `config: repair service accounts by ${actor}`);
      return this.snapshot();
    });
  }

  private activeAccount(accountId: string): StoredServiceAccount {
    const account = this.file.accounts.find((candidate) => candidate.id === accountId);
    if (account?.status !== "active") {
      throw new Error(`unknown active service account: ${accountId}`);
    }
    return account;
  }

  private async replaceAccount(account: StoredServiceAccount, title: string): Promise<void> {
    await this.commit(
      {
        version: 1,
        accounts: this.file.accounts.map((candidate) =>
          candidate.id === account.id ? account : candidate,
        ),
      },
      title,
    );
  }

  private async commit(file: ServiceAccountFile, title: string): Promise<void> {
    const normalized = normalizeFile(file);
    await this.options.log.writeText(
      SERVICE_ACCOUNTS_PATH,
      `${JSON.stringify(normalized, null, 2)}\n`,
      title,
    );
    this.file = normalized;
    this.source = "bucket";
    this.configError = undefined;
    this.configErrorRetryable = false;
  }

  private assertWritable(): void {
    if (this.configError !== undefined) {
      throw new Error(`service account config is unavailable: ${this.configError}`);
    }
  }

  private async enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function parseToken(token: string): { accountId: string; keyId: string } | undefined {
  const match = /^xtap_sa_([a-f0-9]+)_([a-f0-9]+)_([A-Za-z0-9_-]{32,})$/.exec(token);
  if (match === null) return undefined;
  const accountId = match[1];
  const keyId = match[2];
  if (accountId === undefined || keyId === undefined) return undefined;
  return { accountId, keyId };
}

function issueKey(
  accountId: string,
  createdAt: string,
  expiresAt: string,
): { key: StoredServiceAccountKey; token: string } {
  const keyId = randomId(8);
  const secret = randomBytes(32).toString("base64url");
  const token = `${TOKEN_PREFIX}_${accountId}_${keyId}_${secret}`;
  return {
    key: {
      id: keyId,
      token_hash: hashToken(token),
      created_at: createdAt,
      expires_at: expiresAt,
    },
    token,
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function tokenHashMatches(token: string, tokenHash: string): boolean {
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(tokenHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function randomId(bytes: number): string {
  // Hex avoids the underscore delimiter used by the credential format.
  return randomBytes(bytes).toString("hex");
}

function isExpired(key: StoredServiceAccountKey, now: Date): boolean {
  return key.expires_at !== undefined && Date.parse(key.expires_at) <= now.getTime();
}

function expiresAt(now: Date): string {
  return new Date(now.getTime() + KEY_TTL_MS).toISOString();
}

function normalizeName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!ACCOUNT_NAME.test(normalized)) {
    throw new Error("service account name must use lowercase letters, numbers, and hyphens");
  }
  return normalized;
}

function normalizeScopes(scopes: readonly ServiceAccountScope[]): ServiceAccountScope[] {
  const normalized = [...new Set(scopes)].sort();
  if (normalized.length === 0) throw new Error("service account needs at least one scope");
  return normalized;
}

function normalizeFile(file: ServiceAccountFile): ServiceAccountFile {
  const names = new Set<string>();
  const ids = new Set<string>();
  const accounts = file.accounts.map((account) => {
    const name = normalizeName(account.name);
    if (names.has(name)) throw new Error(`duplicate service account name: ${name}`);
    if (ids.has(account.id)) throw new Error(`duplicate service account id: ${account.id}`);
    names.add(name);
    ids.add(account.id);
    const keyIds = new Set<string>();
    const keys = account.keys.map((key) => {
      if (keyIds.has(key.id)) throw new Error(`duplicate service account key: ${key.id}`);
      keyIds.add(key.id);
      return { ...key };
    });
    return { ...account, name, scopes: normalizeScopes(account.scopes), keys };
  });
  return { version: 1, accounts: accounts.sort((a, b) => a.name.localeCompare(b.name)) };
}

function toSummary(account: StoredServiceAccount): ServiceAccountSummary {
  return {
    id: account.id,
    name: account.name,
    scopes: account.scopes,
    status: account.status,
    created_at: account.created_at,
    updated_at: account.updated_at,
    keys: account.keys.map(({ id, created_at, expires_at }) => ({
      id,
      created_at,
      ...(expires_at === undefined ? {} : { expires_at }),
    })),
  };
}

async function loadFile(options: ServiceAccountRegistryOptions): Promise<LoadedServiceAccounts> {
  let raw: string | undefined;
  try {
    raw = await options.log.readText(SERVICE_ACCOUNTS_PATH);
  } catch (error) {
    return {
      file: emptyFile(),
      source: "empty",
      configError: errorMessage(error),
      retryable: true,
    };
  }
  if (raw === undefined) return { file: emptyFile(), source: "empty", retryable: false };
  try {
    return {
      file: normalizeFile(serviceAccountsFileSchema.parse(JSON.parse(raw))),
      source: "bucket",
      retryable: false,
    };
  } catch (error) {
    return {
      file: emptyFile(),
      source: "empty",
      configError: errorMessage(error),
      retryable: false,
    };
  }
}

function emptyFile(): ServiceAccountFile {
  return { version: 1, accounts: [] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "invalid service account config";
}
