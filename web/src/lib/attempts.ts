import { db } from "./store";
export const AUTH_LIMITS = { windowMinutes: 15, perEmail: 8, perClient: 60 };
export const attemptCutoff = () => new Date(Date.now() - AUTH_LIMITS.windowMinutes * 60_000).toISOString();
/** Reserve both buckets in the same SQL statement and before doing work. */
export async function reserveAttempts(scope: string, email: string, client: string): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await (await db()).execute({
    sql: `INSERT INTO auth_attempt(scope,subject,at)
      SELECT ?,subject,? FROM (SELECT ? AS subject UNION ALL SELECT ?)
      WHERE (SELECT count(*) FROM auth_attempt WHERE scope = ? AND subject = ? AND at >= ?) < ?
        AND (SELECT count(*) FROM auth_attempt WHERE scope = ? AND subject = ? AND at >= ?) < ?`,
    args: [scope, now, `email:${email.toLowerCase()}`, `client:${client}`,
      scope, `email:${email.toLowerCase()}`, attemptCutoff(), AUTH_LIMITS.perEmail,
      scope, `client:${client}`, attemptCutoff(), AUTH_LIMITS.perClient],
  });
  return result.rowsAffected === 2;
}
