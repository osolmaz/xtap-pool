import type { Context, Hono } from "hono";
import type { ServiceAccountScope } from "@xtap-pool/shared";
import type { ConsumerRuntime } from "./consumer-runtime.js";
import type { ConsumerRoute } from "./consumer-query.js";
import type { ServiceAccountRegistry } from "./service-accounts.js";
import { ConsumerHttpError, consumerErrorResponse } from "./consumer-errors.js";

export function registerConsumerRoutes(
  app: Hono,
  runtime: ConsumerRuntime | undefined,
  session: (c: Context) => boolean,
  accounts: ServiceAccountRegistry,
): void {
  const routes: [string, ConsumerRoute, ServiceAccountScope[]][] = [
    ["/api/units", "bootstrap", ["units:read", "taxonomy:read"]],
    ["/api/changes", "changes", ["units:read", "taxonomy:read", "observations:read"]],
    ["/api/observations", "history", ["units:read", "observations:read"]],
  ];
  for (const [path, route, scopes] of routes)
    app.get(path, async (c) => {
      const authorize = () => {
        if (session(c)) return;
        const token = /^Bearer (.+)$/iu.exec(c.req.header("authorization") ?? "")?.[1];
        const identity = token === undefined ? undefined : accounts.authenticate(token.trim());
        if (identity === undefined)
          throw new ConsumerHttpError(
            401,
            "unauthenticated",
            "A current service credential or member session is required.",
          );
        if (!scopes.every((scope) => identity.scopes.includes(scope)))
          throw new ConsumerHttpError(
            403,
            "scope_required",
            `Required scopes: ${scopes.join(", ")}.`,
          );
      };
      try {
        authorize();
        if (runtime === undefined)
          throw new ConsumerHttpError(
            503,
            "projection_unavailable",
            "The consumer runtime is unavailable.",
          );
        return await runtime.read(route, c.req.raw, authorize);
      } catch (error) {
        return consumerErrorResponse(error);
      }
    });
}
