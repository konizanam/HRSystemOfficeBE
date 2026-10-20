import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ActingAsService } from './acting-as.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';
import { MobilePairingService } from './mobile-pairing.service';
import { OidcService } from './oidc.service';
import { PasswordService } from './password.service';
import { ProfileController } from './profile.controller';
import { RolesGuard } from './roles.guard';
import { ScopeService } from './scope.service';
import { SessionController } from './session.controller';
import { SessionGuard } from './session.guard';
import { SessionService } from './session.service';

/**
 * Authentication, sessions, "Working as" and data scoping (section 4). The guards are global:
 * SessionGuard runs first and builds the SecurityContext, then RolesGuard checks `@Roles(...)`.
 * Feature modules import this module for ScopeService.
 */
@Module({
  controllers: [AuthController, SessionController, ProfileController],
  providers: [
    PasswordService,
    ScopeService,
    SessionService,
    AuthService,
    MfaService,
    OidcService,
    ActingAsService,
    MobilePairingService,
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [ScopeService, SessionService, PasswordService],
})
export class AuthModule {}
