import { Body, Controller, Get, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import { ApiAcceptedResponse, ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  ChangePasswordRequestSchema,
  ForgotPasswordRequestSchema,
  type ForgotPasswordResponse,
  ForgotPasswordResponseSchema,
  LoginRequestSchema,
  type LoginResponse,
  LoginResponseSchema,
  MfaEnrollResponseSchema,
  MfaVerifyRequestSchema,
  OidcStartQuerySchema,
  ResetPasswordRequestSchema,
  SESSION_COOKIE,
} from '@peoplehub/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createZodDto } from 'nestjs-zod';
import type { RequestMeta, SecurityContext } from '../../common/context/security-context';
import { Ctx, Meta } from '../../common/http/request';
import { env } from '../../config/env';
import { AuthService, webUrl } from './auth.service';
import { AllowPendingPasswordChange, AuthRateLimit, Public } from './decorators';
import { MfaService } from './mfa.service';
import { OIDC_FLOW_COOKIE, OIDC_FLOW_COOKIE_PATH, OIDC_FLOW_TTL_SECONDS, OidcService } from './oidc.service';
import { SessionService } from './session.service';

class LoginDto extends createZodDto(LoginRequestSchema) {}
/** A discriminated union, so it cannot be a class; the constructor still documents the response. */
const LoginResponseDto = createZodDto(LoginResponseSchema);
class ForgotPasswordDto extends createZodDto(ForgotPasswordRequestSchema) {}
class ForgotPasswordResponseDto extends createZodDto(ForgotPasswordResponseSchema) {}
class ResetPasswordDto extends createZodDto(ResetPasswordRequestSchema) {}
class ChangePasswordDto extends createZodDto(ChangePasswordRequestSchema) {}
class MfaEnrollResponseDto extends createZodDto(MfaEnrollResponseSchema) {}
class MfaVerifyDto extends createZodDto(MfaVerifyRequestSchema) {}
class OidcStartQueryDto extends createZodDto(OidcStartQuerySchema) {}

const FORGOT_MESSAGE = 'If the account exists and has an email address, a reset link has been sent.';

/** Section 12.1. Every route is rate limited to 10 requests per minute per IP (section 10.1). */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    private readonly oidc: OidcService,
  ) {}

  @Post('login')
  @Public()
  @AuthRateLimit()
  @HttpCode(200)
  @ApiOkResponse({ type: LoginResponseDto })
  async login(
    @Body() body: LoginDto,
    @Meta() meta: RequestMeta,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LoginResponse> {
    const result = await this.auth.login(body, meta);
    if (result.session) {
      await this.sessions.revokeToken(req.cookies?.[SESSION_COOKIE]);
      this.sessions.setCookies(reply, result.session);
    }
    return result.response;
  }

  @Post('logout')
  @AuthRateLimit()
  @AllowPendingPasswordChange()
  @HttpCode(204)
  @ApiNoContentResponse()
  async logout(@Ctx() ctx: SecurityContext, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    await this.auth.logout(ctx);
    this.sessions.clearCookies(reply);
  }

  @Post('password/forgot')
  @Public()
  @AuthRateLimit()
  @HttpCode(202)
  @ApiAcceptedResponse({ type: ForgotPasswordResponseDto })
  async forgot(@Body() body: ForgotPasswordDto, @Meta() meta: RequestMeta): Promise<ForgotPasswordResponse> {
    await this.auth.forgotPassword(body.usernameOrEmail, meta);
    return { message: FORGOT_MESSAGE };
  }

  @Post('password/reset')
  @Public()
  @AuthRateLimit()
  @HttpCode(204)
  @ApiNoContentResponse()
  async reset(@Body() body: ResetPasswordDto, @Meta() meta: RequestMeta): Promise<void> {
    await this.auth.resetPassword(body, meta);
  }

  @Post('password/change')
  @AuthRateLimit()
  @AllowPendingPasswordChange()
  @HttpCode(204)
  @ApiNoContentResponse()
  async change(@Ctx() ctx: SecurityContext, @Body() body: ChangePasswordDto): Promise<void> {
    await this.auth.changePassword(ctx, body);
  }

  @Post('mfa/enroll')
  @AuthRateLimit()
  @HttpCode(200)
  @ApiOkResponse({ type: MfaEnrollResponseDto })
  enroll(@Ctx() ctx: SecurityContext): Promise<MfaEnrollResponseDto> {
    return this.mfa.enroll(ctx);
  }

  @Post('mfa/verify')
  @AuthRateLimit()
  @HttpCode(204)
  @ApiNoContentResponse()
  async verify(@Ctx() ctx: SecurityContext, @Body() body: MfaVerifyDto): Promise<void> {
    await this.mfa.verify(ctx, body.code);
  }

  /** Redirects to the identity provider. 404 when OIDC is not configured. */
  @Get('oidc/start')
  @Public()
  @AuthRateLimit()
  async oidcStart(@Query() query: OidcStartQueryDto, @Res() reply: FastifyReply): Promise<void> {
    const { url, cookie } = await this.oidc.start(query.returnTo ?? null);
    void reply.setCookie(OIDC_FLOW_COOKIE, cookie, {
      path: OIDC_FLOW_COOKIE_PATH,
      httpOnly: true,
      sameSite: 'lax',
      secure: env().COOKIE_SECURE,
      maxAge: OIDC_FLOW_TTL_SECONDS,
    });
    await reply.redirect(url, 302);
  }

  /** The identity provider redirects here; we redirect on to the web app. */
  @Get('oidc/callback')
  @Public()
  @AuthRateLimit()
  async oidcCallback(
    @Req() req: FastifyRequest,
    @Meta() meta: RequestMeta,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    this.oidc.assertConfigured();
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const result = await this.oidc.callback(query, req.cookies?.[OIDC_FLOW_COOKIE], meta);
    void reply.clearCookie(OIDC_FLOW_COOKIE, { path: OIDC_FLOW_COOKIE_PATH });
    if (!result.ok) {
      await reply.redirect(`${webUrl()}/login?error=${result.error}`, 302);
      return;
    }
    await this.sessions.revokeToken(req.cookies?.[SESSION_COOKIE]);
    this.sessions.setCookies(reply, result.session);
    await reply.redirect(`${webUrl()}${result.returnTo ?? '/dashboard'}`, 302);
  }
}
