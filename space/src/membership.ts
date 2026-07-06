import { z } from "zod";

import type { DatasetMirror } from "./dataset.js";

export const POOL_CONFIG_PATH = "config/pool.json";

const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const memberOrgSchema = z.object({
  name: z.string(),
  sub: z.string().min(1),
  display_name: z.string().min(1).optional(),
});

const poolConfigSchema = z.object({
  version: z.literal(1),
  admins: z.array(z.string()).default([]),
  members: z.array(z.string()).default([]),
  member_orgs: z.array(memberOrgSchema).default([]),
  updated_at: z.string(),
  updated_by: z.string().optional(),
});

export type PoolConfig = z.infer<typeof poolConfigSchema>;
export type MemberOrgGrant = z.infer<typeof memberOrgSchema>;

export type PoolIdentityOrg = {
  sub: string;
  name?: string;
};

export type PoolIdentity = {
  username: string;
  orgs?: readonly PoolIdentityOrg[];
};

export type PoolAccessGrant =
  { type: "admin" } | { type: "member" } | { type: "member_org"; org: MemberOrgGrant };

export type PoolSnapshot = PoolConfig & {
  bootstrap_admins: readonly string[];
  source: "dataset" | "bootstrap";
  config_error?: string;
};

type PoolMembershipOptions = {
  mirror: DatasetMirror;
  bootstrapMembers: readonly string[];
  bootstrapAdmins: readonly string[];
  now: () => Date;
};

export class PoolMembership {
  private config: PoolConfig;
  private readonly bootstrapAdmins: readonly string[];
  private source: PoolSnapshot["source"];
  private configError: string | undefined;
  private mutationTail: Promise<void> = Promise.resolve();

  private constructor(
    private readonly options: PoolMembershipOptions,
    config: PoolConfig,
    source: PoolSnapshot["source"],
    configError?: string,
  ) {
    this.bootstrapAdmins = normalizeUsers(
      options.bootstrapAdmins.length > 0
        ? options.bootstrapAdmins
        : options.bootstrapMembers.slice(0, 1),
    );
    this.config = normalizeConfig(config);
    this.source = source;
    this.configError = configError;
  }

  static async load(options: PoolMembershipOptions): Promise<PoolMembership> {
    const fallback = bootstrapConfig(options);
    const raw = await options.mirror.readText(POOL_CONFIG_PATH);
    if (raw === undefined) return new PoolMembership(options, fallback, "bootstrap");
    try {
      const parsed = poolConfigSchema.parse(JSON.parse(raw));
      return new PoolMembership(options, parsed, "dataset");
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid pool config";
      return new PoolMembership(options, fallback, "bootstrap", message);
    }
  }

  isMember(username: string): boolean {
    return this.memberSet().has(normalizeUsername(username));
  }

  accessFor(identity: PoolIdentity): PoolAccessGrant | undefined {
    const user = normalizeUsername(identity.username);
    if (this.adminSet().has(user)) return { type: "admin" };
    if (normalizeUsers(this.config.members).includes(user)) return { type: "member" };

    const matchingOrg = this.memberOrgFor(identity.orgs ?? []);
    if (matchingOrg !== undefined) return { type: "member_org", org: matchingOrg };
    return undefined;
  }

  isAdmin(username: string): boolean {
    return this.adminSet().has(normalizeUsername(username));
  }

  memberOrgIds(): string[] {
    return normalizeMemberOrgs(this.config.member_orgs).map((org) => org.sub);
  }

  snapshot(): PoolSnapshot {
    const admins = [...this.adminSet()].sort();
    const members = [...new Set([...normalizeUsers(this.config.members), ...admins])].sort();
    const snapshot: PoolSnapshot = {
      version: 1,
      admins,
      members,
      member_orgs: normalizeMemberOrgs(this.config.member_orgs),
      updated_at: this.config.updated_at,
      bootstrap_admins: this.bootstrapAdmins,
      source: this.source,
    };
    if (this.config.updated_by !== undefined) snapshot.updated_by = this.config.updated_by;
    if (this.configError !== undefined) snapshot.config_error = this.configError;
    return snapshot;
  }

  async addMember(actor: string, username: string): Promise<PoolSnapshot> {
    return this.enqueueMutation(async () => {
      const user = normalizeUsername(username);
      if (this.memberSet().has(user)) return this.snapshot();
      const nextConfig = {
        ...this.config,
        members: [...normalizeUsers(this.config.members), user].sort(),
      };
      await this.commit(nextConfig, actor, `config: add pool member ${user}`);
      return this.snapshot();
    });
  }

  async removeMember(actor: string, username: string): Promise<PoolSnapshot> {
    return this.enqueueMutation(async () => {
      const user = normalizeUsername(username);
      if (this.adminSet().has(user))
        throw new Error(`@${user} is an admin; demote before removing`);
      const nextMembers = normalizeUsers(this.config.members).filter((member) => member !== user);
      if (nextMembers.length === this.config.members.length) return this.snapshot();
      await this.commit(
        { ...this.config, members: nextMembers },
        actor,
        `config: remove pool member ${user}`,
      );
      return this.snapshot();
    });
  }

  async addAdmin(actor: string, username: string): Promise<PoolSnapshot> {
    return this.enqueueMutation(async () => {
      const user = normalizeUsername(username);
      if (this.adminSet().has(user)) return this.snapshot();
      const nextConfig = {
        ...this.config,
        admins: [...normalizeUsers(this.config.admins), user].sort(),
        members: [...new Set([...normalizeUsers(this.config.members), user])].sort(),
      };
      await this.commit(nextConfig, actor, `config: add pool admin ${user}`);
      return this.snapshot();
    });
  }

  async removeAdmin(actor: string, username: string): Promise<PoolSnapshot> {
    return this.enqueueMutation(async () => {
      const user = normalizeUsername(username);
      if (this.bootstrapAdmins.includes(user)) {
        throw new Error(`@${user} is a bootstrap admin; change POOL_ADMINS to demote`);
      }
      const nextAdmins = normalizeUsers(this.config.admins).filter((admin) => admin !== user);
      if (nextAdmins.length === this.config.admins.length) return this.snapshot();
      if (new Set([...nextAdmins, ...this.bootstrapAdmins]).size === 0) {
        throw new Error("pool must keep at least one admin");
      }
      await this.commit(
        { ...this.config, admins: nextAdmins },
        actor,
        `config: remove pool admin ${user}`,
      );
      return this.snapshot();
    });
  }

  async addMemberOrg(actor: string, org: MemberOrgGrant): Promise<PoolSnapshot> {
    return this.enqueueMutation(async () => {
      const grant = normalizeMemberOrg(org);
      if (this.memberOrgSet().has(grant.sub)) return this.snapshot();
      const nextConfig = {
        ...this.config,
        member_orgs: [...normalizeMemberOrgs(this.config.member_orgs), grant].sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
      };
      await this.commit(nextConfig, actor, `config: add member org ${grant.name}`);
      return this.snapshot();
    });
  }

  async removeMemberOrg(actor: string, orgName: string): Promise<PoolSnapshot> {
    return this.enqueueMutation(async () => {
      const name = normalizeOrgName(orgName);
      const nextOrgs = normalizeMemberOrgs(this.config.member_orgs).filter(
        (org) => org.name !== name,
      );
      if (nextOrgs.length === this.config.member_orgs.length) return this.snapshot();
      await this.commit(
        { ...this.config, member_orgs: nextOrgs },
        actor,
        `config: remove member org ${name}`,
      );
      return this.snapshot();
    });
  }

  private adminSet(): Set<string> {
    return new Set([...normalizeUsers(this.config.admins), ...this.bootstrapAdmins]);
  }

  private memberSet(): Set<string> {
    return new Set([...normalizeUsers(this.config.members), ...this.adminSet()]);
  }

  private memberOrgSet(): Set<string> {
    return new Set(normalizeMemberOrgs(this.config.member_orgs).map((org) => org.sub));
  }

  private memberOrgFor(orgs: readonly PoolIdentityOrg[]): MemberOrgGrant | undefined {
    const grantedBySub = new Map(
      normalizeMemberOrgs(this.config.member_orgs).map((org) => [org.sub, org]),
    );
    for (const org of normalizeIdentityOrgs(orgs)) {
      const grant = grantedBySub.get(org.sub);
      if (grant !== undefined) return grant;
    }
    return undefined;
  }

  private async enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async commit(nextConfig: PoolConfig, actor: string, title: string): Promise<void> {
    const committedConfig = normalizeConfig({
      ...nextConfig,
      updated_at: this.options.now().toISOString(),
      updated_by: normalizeUsername(actor),
    });
    await this.options.mirror.writeTextAndCommit(
      POOL_CONFIG_PATH,
      `${JSON.stringify(committedConfig, null, 2)}\n`,
      title,
    );
    this.config = committedConfig;
    this.source = "dataset";
    this.configError = undefined;
  }
}

export function normalizeUsername(username: string): string {
  const normalized = username.trim().toLowerCase();
  if (!USERNAME.test(normalized)) throw new Error(`invalid Hugging Face username: ${username}`);
  return normalized;
}

export function normalizeOrgName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!USERNAME.test(normalized)) throw new Error(`invalid Hugging Face organization: ${name}`);
  return normalized;
}

function normalizeUsers(users: readonly string[]): string[] {
  return [...new Set(users.map(normalizeUsername))].sort();
}

function normalizeMemberOrg(org: MemberOrgGrant): MemberOrgGrant {
  const normalized: MemberOrgGrant = {
    name: normalizeOrgName(org.name),
    sub: org.sub.trim(),
  };
  if (normalized.sub.length === 0) throw new Error("organization sub must not be empty");
  const displayName = org.display_name?.trim();
  if (displayName !== undefined && displayName.length > 0) normalized.display_name = displayName;
  return normalized;
}

function normalizeMemberOrgs(orgs: readonly MemberOrgGrant[]): MemberOrgGrant[] {
  const bySub = new Map<string, MemberOrgGrant>();
  for (const org of orgs.map(normalizeMemberOrg)) {
    bySub.set(org.sub, org);
  }
  return [...bySub.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeIdentityOrgs(orgs: readonly PoolIdentityOrg[]): PoolIdentityOrg[] {
  const bySub = new Map<string, PoolIdentityOrg>();
  for (const org of orgs) {
    const sub = org.sub.trim();
    if (sub.length === 0) continue;
    const normalized: PoolIdentityOrg = { sub };
    if (org.name !== undefined) normalized.name = normalizeOrgName(org.name);
    bySub.set(sub, normalized);
  }
  return [...bySub.values()];
}

function normalizeConfig(config: PoolConfig): PoolConfig {
  const admins = normalizeUsers(config.admins);
  return {
    version: 1,
    admins,
    members: [...new Set([...normalizeUsers(config.members), ...admins])].sort(),
    member_orgs: normalizeMemberOrgs(config.member_orgs),
    updated_at: config.updated_at,
    ...(config.updated_by === undefined
      ? {}
      : { updated_by: normalizeUsername(config.updated_by) }),
  };
}

function bootstrapConfig(options: PoolMembershipOptions): PoolConfig {
  const members = normalizeUsers(options.bootstrapMembers);
  const admins = normalizeUsers(
    options.bootstrapAdmins.length > 0
      ? options.bootstrapAdmins
      : options.bootstrapMembers.slice(0, 1),
  );
  return {
    version: 1,
    admins,
    members: [...new Set([...members, ...admins])].sort(),
    member_orgs: [],
    updated_at: options.now().toISOString(),
  };
}
