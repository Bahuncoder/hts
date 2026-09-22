/** Google OAuth 2.0, authorization-code flow (server-side, confidential
 *  client — this server holds the client secret, so PKCE is not needed; the
 *  `state` parameter is the CSRF defence, checked against a cookie set when
 *  the flow starts).
 *
 *  Configuration: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. Both unset
 *  (the default) means the feature does not exist — no button is shown, and
 *  the routes refuse the request rather than fail confusingly.
 *
 *  The three Google endpoints are overridable
 *  (GOOGLE_OAUTH_AUTH_URL/TOKEN_URL/USERINFO_URL) so tests can point this at
 *  a fake server instead of accounts.google.com; production never sets them.
 */

export function googleEnabled(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

const AUTH_URL = () => process.env.GOOGLE_OAUTH_AUTH_URL ?? "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = () => process.env.GOOGLE_OAUTH_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
const USERINFO_URL = () => process.env.GOOGLE_OAUTH_USERINFO_URL ?? "https://www.googleapis.com/oauth2/v3/userinfo";

export function googleAuthUrl(state: string, redirectUri: string): string {
  const url = new URL(AUTH_URL());
  url.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID!);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  // Lets someone with several Google accounts pick, rather than silently
  // using whichever is already signed in.
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

class GoogleAuthError extends Error {}

async function exchangeCode(code: string, redirectUri: string): Promise<string> {
  const res = await fetch(TOKEN_URL(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, redirect_uri: redirectUri, grant_type: "authorization_code",
      client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new GoogleAuthError(`token exchange failed: ${res.status}`);
  const body = await res.json() as { access_token?: string };
  if (typeof body.access_token !== "string") throw new GoogleAuthError("no access token in response");
  return body.access_token;
}

export type GoogleProfile = { email: string; emailVerified: boolean; name: string | null };

async function fetchProfile(accessToken: string): Promise<GoogleProfile> {
  const res = await fetch(USERINFO_URL(), {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new GoogleAuthError(`userinfo failed: ${res.status}`);
  const body = await res.json() as { email?: string; email_verified?: boolean; verified_email?: boolean; name?: string };
  if (typeof body.email !== "string") throw new GoogleAuthError("no email in userinfo response");
  return {
    email: body.email,
    // Google's OIDC userinfo endpoint uses email_verified; the older
    // People-API-style response used verified_email. Accept either.
    emailVerified: body.email_verified === true || body.verified_email === true,
    name: typeof body.name === "string" ? body.name : null,
  };
}

/** The whole exchange: an authorization code becomes a verified profile, or
 *  this throws. Never returns a profile Google has not itself vouched for. */
export async function googleProfile(code: string, redirectUri: string): Promise<GoogleProfile> {
  const token = await exchangeCode(code, redirectUri);
  return fetchProfile(token);
}
