import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// A minimal OpenID Connect provider for integration tests: discovery, JWKS and a token endpoint
// that issues RS256-signed ID tokens. Tests register an authorization code with `issueCode`, as
// if the user had signed in at the provider, and then call the API's callback with it.

export interface FakeOidcProvider {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Registers a code for the given subject; the nonce and PKCE challenge come from the auth URL. */
  issueCode(
    authorizationUrl: string,
    claims: { sub: string; email?: string; preferred_username?: string },
  ): string;
  close(): Promise<void>;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function startFakeOidcProvider(): Promise<FakeOidcProvider> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomUUID();
  const clientId = 'peoplehub-test';
  const clientSecret = 'test-secret';
  const codes = new Map<string, { claims: Record<string, unknown>; nonce: string; challenge: string }>();
  let issuer = '';

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', issuer);
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/.well-known/openid-configuration') {
        return json(200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_post'],
        });
      }
      if (url.pathname === '/jwks') {
        return json(200, {
          keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }],
        });
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        const form = new URLSearchParams(await readBody(req));
        const entry = codes.get(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        if (
          !entry ||
          form.get('client_id') !== clientId ||
          form.get('client_secret') !== clientSecret ||
          challenge !== entry.challenge
        ) {
          return json(400, { error: 'invalid_grant' });
        }
        codes.delete(form.get('code') ?? '');
        const now = Math.floor(Date.now() / 1000);
        const header = base64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
        const payload = base64url(
          JSON.stringify({
            iss: issuer,
            aud: clientId,
            iat: now,
            exp: now + 300,
            nonce: entry.nonce,
            ...entry.claims,
          }),
        );
        const signature = sign('sha256', Buffer.from(`${header}.${payload}`), privateKey).toString(
          'base64url',
        );
        return json(200, {
          access_token: randomUUID(),
          token_type: 'Bearer',
          expires_in: 300,
          id_token: `${header}.${payload}.${signature}`,
        });
      }
      json(404, { error: 'not_found' });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    clientId,
    clientSecret,
    issueCode(authorizationUrl, claims) {
      const params = new URL(authorizationUrl).searchParams;
      const code = randomUUID();
      codes.set(code, {
        claims,
        nonce: params.get('nonce') ?? '',
        challenge: params.get('code_challenge') ?? '',
      });
      return code;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
