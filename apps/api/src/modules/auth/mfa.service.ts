import { Injectable } from '@nestjs/common';
import type { MfaEnrollResponse } from '@peoplehub/shared';
import { authenticator } from 'otplib';
import { toDataURL } from 'qrcode';
import { AuditService } from '../../audit/audit.service';
import type { SecurityContext } from '../../common/context/security-context';
import { ConflictError, ValidationError } from '../../common/errors/domain-errors';
import { EncryptionService } from '../../crypto/encryption.service';
import { DbService } from '../../prisma/db.service';

export const MFA_ISSUER = 'PeopleHub';

/** RFC 6238 TOTP, 30-second steps; one step of clock drift either way is accepted. */
const totp = authenticator.clone({ window: 1 });

/** Checks a 6-digit code against a base32 secret. */
export function verifyTotp(code: string, secret: string): boolean {
  try {
    return totp.check(code, secret);
  } catch {
    return false;
  }
}

/**
 * Optional TOTP MFA for local accounts (section 4.3). Enrolment stores the secret encrypted in
 * `User.mfaSecretEnc` but leaves MFA off until a code is verified (`User.mfaEnabledAt`), so a
 * half-finished enrolment never locks anyone out.
 */
@Injectable()
export class MfaService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly encryption: EncryptionService,
  ) {}

  async enroll(ctx: SecurityContext): Promise<MfaEnrollResponse> {
    const secret = totp.generateSecret();
    const otpauthUrl = totp.keyuri(ctx.username, MFA_ISSUER, secret);
    await this.db.tx(ctx, async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: ctx.userId } });
      if (user.authProvider !== 'LOCAL') {
        throw ValidationError.field(
          '',
          'Multi-factor sign-in for OAuth accounts is managed by your identity provider',
        );
      }
      if (user.mfaEnabledAt) throw new ConflictError('Multi-factor sign-in is already enabled');
      await tx.user.update({
        where: { id: user.id },
        data: {
          mfaSecretEnc: this.encryption.encrypt(secret),
          mfaEnabledAt: null,
          version: { increment: 1 },
        },
      });
      this.audit.record(tx, ctx, {
        category: 'AUTH',
        action: 'AUTH.MFA_ENROLMENT_STARTED',
        entityType: 'User',
        entityId: user.id,
        subjectEmployeeId: user.employeeId,
      });
    });
    return { secret, otpauthUrl, qrDataUrl: await toDataURL(otpauthUrl, { margin: 1, width: 240 }) };
  }

  async verify(ctx: SecurityContext, code: string): Promise<void> {
    await this.db.tx(ctx, async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: ctx.userId } });
      if (user.mfaEnabledAt) throw new ConflictError('Multi-factor sign-in is already enabled');
      if (!user.mfaSecretEnc) throw ValidationError.field('code', 'Start enrolment before entering a code');
      if (!verifyTotp(code, this.encryption.decrypt(user.mfaSecretEnc))) {
        throw ValidationError.field(
          'code',
          'The code is not valid. Check the time on your device and try again.',
        );
      }
      const after = await tx.user.update({
        where: { id: user.id },
        data: { mfaEnabledAt: new Date(), version: { increment: 1 } },
      });
      this.audit.record(tx, ctx, {
        category: 'AUTH',
        action: 'AUTH.MFA_ENROLLED',
        entityType: 'User',
        entityId: user.id,
        subjectEmployeeId: user.employeeId,
        before: user,
        after,
      });
    });
  }

  /** Sign-in check. Returns false when MFA is off for this user. */
  isEnabled(user: { mfaEnabledAt: Date | null; mfaSecretEnc: string | null }): boolean {
    return !!user.mfaEnabledAt && !!user.mfaSecretEnc;
  }

  checkCode(user: { mfaSecretEnc: string | null }, code: string): boolean {
    return !!user.mfaSecretEnc && verifyTotp(code, this.encryption.decrypt(user.mfaSecretEnc));
  }
}
