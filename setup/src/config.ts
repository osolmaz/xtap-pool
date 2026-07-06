export type SetupConfig = {
  namespace: string;
  spaceRepo: string;
  datasetRepo: string;
  allowedUsers: readonly string[];
};

const REPO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function defaultSetupConfig(username: string): SetupConfig {
  return {
    namespace: username,
    spaceRepo: `${username}/xtap-pool`,
    datasetRepo: `${username}/xtap-pool-data`,
    allowedUsers: [username],
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
