import { Injectable } from '@nestjs/common';
import { AUTH_POLICY, type MobilePairingResponse } from '@peoplehub/shared';
import { toDataURL } from 'qrcode';
import { AuditService } from '../../audit/audit.service';
import type { SecurityContext } from '../../common/context/security-context';
import { env } from '../../config/env';
import { DbService } from '../../prisma/db.service';
import { hashToken, randomToken } from './auth-policy';

/** Scheme of the QR payload read by the mobile app. */
export const PAIRING_URI_PREFIX = 'peoplehub://pair';

export function pairingUri(serverUrl: string, token: string): string {
  return `${PAIRING_URI_PREFIX}?server=${encodeURIComponent(serverUrl)}&token=${encodeURIComponent(token)}`;
}

/**
 * "Setup mobile" (ASSUMPTION A3): a short-lived, single-use pairing token for the signed-in user,
 * shown as a QR code together with the server URL. Only the token's sha256 is stored, and every
 * token issued is audited (AUTH.MOBILE_PAIRING_CREATED).
 */
@Injectable()
export class MobilePairingService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async create(ctx: SecurityContext, now = new Date()): Promise<MobilePairingResponse> {
    const token = randomToken(24);
    const expiresAt = new Date(now.getTime() + AUTH_POLICY.mobilePairingMinutes * 60_000);
    const serverUrl = env().PUBLIC_URL.replace(/\/+$/, '');
    await this.db.tx(ctx, async (tx) => {
      const row = await tx.mobilePairingToken.create({
        data: { userId: ctx.userId, tokenHash: hashToken(token), expiresAt, createdAt: now },
      });
      this.audit.record(tx, ctx, {
        category: 'AUTH',
        action: 'AUTH.MOBILE_PAIRING_CREATED',
        entityType: 'MobilePairingToken',
        entityId: row.id,
        subjectEmployeeId: ctx.selfEmployeeId,
        metadata: { expiresAt: expiresAt.toISOString() },
      });
    });
    return {
      serverUrl,
      token,
      expiresAt: expiresAt.toISOString(),
      qrDataUrl: await toDataURL(pairingUri(serverUrl, token), { margin: 1, width: 240 }),
    };
  }
}
