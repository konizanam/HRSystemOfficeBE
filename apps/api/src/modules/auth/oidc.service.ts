import { Injectable, Logger } from '@nestjs/common';
import * as client from 'openid-client';
import { AuditService } from '../../audit/audit.service';
import type { RequestMeta } from '../../common/context/security-context';
import { NotFoundError } from '../../common/errors/domain-errors';
import { env, oidcConfigured } from '../../config/env';
import { EncryptionService } from '../../crypto/encryption.service';
import { DbService } from '../../prisma/db.service';
import { AuthService } from './auth.service';
import type { NewSession } from './session.service';

/** Holds state, nonce and the PKCE verifier between /oidc/start and /oidc/callback. */
export const OIDC_FLOW_COOKIE = 'ph_oidc';
export const OIDC_FLOW_COOKIE_PATH = '/api/v1/auth/oidc';
export const OIDC_FLOW_TTL_SECONDS = 600;

interface FlowState {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string | null;
  /** Epoch milliseconds. */
  exp: number;
}

export type OidcErrorCode =
  'oidc_state' | 'oidc_failed' | 'oidc_unknown_user' | 'oidc_inactive' | 'oidc_not_oauth_account';

export type OidcCallbackResult =
  { ok: true; session: NewSession; returnTo: string | null } | { ok: false; error: OidcErrorCode };

class OidcFlowError extends Error {
  constructor(
    readonly code: OidcErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * OAuth/OIDC sign-in (section 4.3) with openid-client's functional API. The authorization code
 * flow uses PKCE (S256), state and nonce; they travel in a short-lived AES-GCM-encrypted cookie,
 * so a tampered or replayed cookie fails to decrypt. The `sub` claim maps to
 * `User.externalSubject`; unknown subjects are refused unless OIDC_AUTO_PROVISION is on.
 */
@Injectable()
export class OidcService {
  private readonly logger = new Logger(OidcService.name);
  private configuration: Promise<client.Configuration> | null = null;

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly encryption: EncryptionService,
  ) {}

  isConfigured(): boolean {
    return oidcConfigured();
  }

  assertConfigured(): void {
    if (!this.isConfigured()) throw new NotFoundError('OIDC sign-in', 'OAuth sign-in is not configured');
  }

  /** Builds the authorization URL and the encrypted flow cookie. */
  async start(returnTo: string | null, now = Date.now()): Promise<{ url: string; cookie: string }> {
    this.assertConfigured();
    const config = await this.config();
    const e = env();
    const codeVerifier = client.randomPKCECodeVerifier();
    const flow: FlowState = {
      state: client.randomState(),
      nonce: client.randomNonce(),
      codeVerifier,
      returnTo,
      exp: now + OIDC_FLOW_TTL_SECONDS * 1000,
    };
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: e.OIDC_REDIRECT_URI as string,
      scope: e.OIDC_SCOPES,
      response_type: 'code',
      code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      state: flow.state,
      nonce: flow.nonce,
    });
    return { url: url.href, cookie: this.encryption.encrypt(JSON.stringify(flow)) };
  }

  /**
   * Completes the flow. Never throws for a user-facing failure: it audits AUTH.LOGIN_FAILURE and
   * returns an error code for the redirect back to the sign-in page.
   */
  async callback(
    query: string,
    flowCookie: string | undefined,
    meta: RequestMeta,
    now = new Date(),
  ): Promise<OidcCallbackResult> {
    this.assertConfigured();
    let subject: string | null = null;
    try {
      const flow = this.readFlow(flowCookie, now.getTime());
      const config = await this.config();
      const currentUrl = new URL(env().OIDC_REDIRECT_URI as string);
      currentUrl.search = query;
      const tokens = await client.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: flow.codeVerifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims?.sub) throw new OidcFlowError('oidc_failed', 'The ID token has no subject');
      subject = claims.sub;
      const user = await this.findOrProvision(claims, meta);
      const session = await this.auth.openSession(
        user,
        meta,
        { provider: 'OAUTH', issuer: claims.iss },
        now,
        (tx) => tx.user.update({ where: { id: user.id }, data: { lastLoginAt: now } }),
      );
      return { ok: true, session, returnTo: flow.returnTo };
    } catch (err) {
      const code = err instanceof OidcFlowError ? err.code : 'oidc_failed';
      if (!(err instanceof OidcFlowError)) this.logger.warn({ err }, 'OIDC callback failed');
      await this.audit.recordStandalone(meta, {
        category: 'AUTH',
        action: 'AUTH.LOGIN_FAILURE',
        outcome: 'FAILURE',
        reason: code.toUpperCase(),
        metadata: {
          provider: 'OAUTH',
          subject,
          detail: err instanceof Error ? err.message.slice(0, 300) : String(err),
        },
      });
      return { ok: false, error: code };
    }
  }

  private async findOrProvision(
    claims: client.IDToken,
    meta: RequestMeta,
  ): Promise<{ id: string; username: string; employeeId: number | null }> {
    const existing = await this.db.prisma.user.findUnique({ where: { externalSubject: claims.sub } });
    if (existing) {
      if (!existing.isActive) throw new OidcFlowError('oidc_inactive', 'The account is not active');
      if (existing.authProvider !== 'OAUTH') {
        throw new OidcFlowError('oidc_not_oauth_account', 'The account signs in with a local password');
      }
      return existing;
    }
    if (!env().OIDC_AUTO_PROVISION) {
      throw new OidcFlowError('oidc_unknown_user', 'No user is linked to this identity');
    }
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : null;
    const preferred = typeof claims.preferred_username === 'string' ? claims.preferred_username : null;
    const base = (preferred ?? email ?? `oidc-${claims.sub}`).toLowerCase().slice(0, 140);
    return this.db.tx({ ...meta }, async (tx) => {
      let username = base;
      for (let i = 2; await tx.user.findUnique({ where: { username } }); i++) username = `${base}.${i}`;
      const emailFree = email ? !(await tx.user.findUnique({ where: { email } })) : false;
      const user = await tx.user.create({
        data: {
          username,
          email: emailFree ? email : null,
          authProvider: 'OAUTH',
          externalSubject: claims.sub,
          roles: ['EMPLOYEE'],
        },
      });
      this.audit.record(
        tx,
        { ...meta, userId: user.id, username },
        {
          category: 'AUTH',
          action: 'AUTH.USER_PROVISIONED',
          entityType: 'User',
          entityId: user.id,
          after: user,
          metadata: { provider: 'OAUTH', issuer: claims.iss },
        },
      );
      return user;
    });
  }

  private readFlow(cookie: string | undefined, now: number): FlowState {
    if (!cookie) throw new OidcFlowError('oidc_state', 'The sign-in cookie is missing');
    let flow: FlowState;
    try {
      flow = JSON.parse(this.encryption.decrypt(cookie)) as FlowState;
    } catch {
      throw new OidcFlowError('oidc_state', 'The sign-in cookie is not valid');
    }
    if (typeof flow.exp !== 'number' || flow.exp < now) {
      throw new OidcFlowError('oidc_state', 'The sign-in attempt took too long');
    }
    return flow;
  }

  /** Discovery runs once and is cached; a failure is retried on the next sign-in. */
  private config(): Promise<client.Configuration> {
    if (!this.configuration) {
      const e = env();
      const issuer = new URL(e.OIDC_ISSUER as string);
      const insecure = issuer.protocol === 'http:';
      if (insecure && e.NODE_ENV === 'production') {
        throw new Error('OIDC_ISSUER must use https in production');
      }
      this.configuration = client
        .discovery(
          issuer,
          e.OIDC_CLIENT_ID as string,
          undefined,
          e.OIDC_CLIENT_SECRET ? client.ClientSecretPost(e.OIDC_CLIENT_SECRET) : client.None(),
          insecure ? { execute: [client.allowInsecureRequests] } : undefined,
        )
        .catch((err: unknown) => {
          this.configuration = null;
          throw err;
        });
    }
    return this.configuration;
  }
}
