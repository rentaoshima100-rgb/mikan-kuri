// Googleサービスアカウントのアクセストークン取得 (JWT bearer grant)。
// 依存追加を避けるため node:crypto でRS256署名する。
import { createSign } from "node:crypto";

export interface ServiceAccount {
  client_email: string;
  private_key: string;
}

const b64url = (input: string | Buffer) =>
  Buffer.from(input).toString("base64url");

export function buildJwt(sa: ServiceAccount, scopes: string[], nowMs: number): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const iat = Math.floor(nowMs / 1000);
  const payload = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: scopes.join(" "),
      aud: "https://oauth2.googleapis.com/token",
      iat,
      exp: iat + 3600,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(sa.private_key).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

export async function getGoogleAccessToken(
  sa: ServiceAccount,
  scopes: string[],
  fetchImpl: typeof fetch = fetch,
  nowMs = Date.now(),
): Promise<string> {
  const jwt = buildJwt(sa, scopes, nowMs);
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`Googleトークン取得失敗: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

export function parseServiceAccount(json: string): ServiceAccount {
  const parsed = JSON.parse(json) as Partial<ServiceAccount>;
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("サービスアカウントJSONに client_email / private_key がありません");
  }
  return { client_email: parsed.client_email, private_key: parsed.private_key };
}
