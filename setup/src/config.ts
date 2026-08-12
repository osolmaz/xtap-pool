export type SetupConfig = {
  namespace: string;
  spaceRepo: string;
  rawBucket: string;
  indexBucket: string;
  allowedUsers: readonly string[];
  poolAdmins: readonly string[];
};

const REPO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function defaultSetupConfig(username: string): SetupConfig {
  return {
    namespace: username,
    spaceRepo: `${username}/xtap-pool`,
    rawBucket: `${username}/xtap-pool-data`,
    indexBucket: `${username}/xtap-pool-bucket`,
    allowedUsers: [username],
    poolAdmins: [username],
  };
}

export function existingSpaceConfig(
  username: string,
  spaceRepo: string,
  variables: ReadonlyMap<string, string>,
): SetupConfig {
  const spaceError = validateRepoId(spaceRepo);
  if (spaceError !== undefined) throw new Error(spaceError);
  const namespace = spaceRepo.split("/")[0] ?? "";
  const rawBucket = variables.get("RAW_BUCKET") ?? repoInNamespace(namespace, "xtap-pool-data");
  const rawBucketError = validateRepoId(rawBucket);
  if (rawBucketError !== undefined)
    throw new Error(`Invalid RAW_BUCKET on ${spaceRepo}: ${rawBucket}`);
  const indexBucket =
    variables.get("INDEX_BUCKET") ?? repoInNamespace(namespace, "xtap-pool-bucket");
  const bucketError = validateRepoId(indexBucket);
  if (bucketError !== undefined)
    throw new Error(`Invalid INDEX_BUCKET on ${spaceRepo}: ${indexBucket}`);
  const allowedUsers = usersFromVariable(variables.get("ALLOWED_USERS"), [username]);
  const poolAdmins = usersFromVariable(variables.get("POOL_ADMINS"), allowedUsers.slice(0, 1));
  return {
    namespace,
    spaceRepo,
    rawBucket,
    indexBucket,
    allowedUsers,
    poolAdmins,
  };
}

export function normalizeUsers(input: string): readonly string[] {
  return [
    ...new Set(
      input
        .split(",")
        .map((user) => user.trim())
        .filter((user) => user.length > 0),
    ),
  ];
}

function usersFromVariable(
  value: string | undefined,
  fallback: readonly string[],
): readonly string[] {
  const parsed = value === undefined ? [] : normalizeUsers(value);
  return parsed.length > 0 ? parsed : fallback;
}

export function usersValue(users: readonly string[]): string {
  return users.join(",");
}

export function repoInNamespace(namespace: string, repoName: string): string {
  return `${namespace}/${repoName}`;
}

export function validateRepoId(value: string): string | undefined {
  return REPO_ID.test(value) ? undefined : "Use owner/name, for example osolmaz/xtap-pool.";
}

export function validateNamespace(value: string): string | undefined {
  return USERNAME.test(value) ? undefined : "Use a Hugging Face username or organization name.";
}

export function validateUserList(value: string): string | undefined {
  const users = normalizeUsers(value);
  if (users.length === 0) return "Enter at least one Hugging Face username.";
  return users.every((user) => USERNAME.test(user))
    ? undefined
    : "Use comma-separated Hugging Face usernames.";
}

export function spacePublicUrl(spaceRepo: string): string {
  const [namespace = "", name = ""] = spaceRepo.split("/");
  return `https://${namespace}-${name}.hf.space`;
}

export function tokenSettingsUrl(): string {
  return "https://huggingface.co/settings/tokens/new?tokenType=fineGrained";
}
