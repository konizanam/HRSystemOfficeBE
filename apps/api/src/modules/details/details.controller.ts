import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  BankAccountsResponseSchema,
  BankAccountUnmaskedSchema,
  BankAccountUnmaskQuerySchema,
  ChangeRequestsQuerySchema,
  ChangeRequestsResponseSchema,
  ChangeRequestSubmitResponseSchema,
  CreateBankAccountRequestSchema,
  CreateDriversLicenceRequestSchema,
  CreateFamilyMemberRequestSchema,
  DeleteDetailRequestSchema,
  DriversLicencesResponseSchema,
  EmployeeTransactionSchema,
  EmployeeTransactionsResponseSchema,
  FamilyMembersResponseSchema,
  FundsResponseSchema,
  IdParamSchema,
  MembershipIdParamSchema,
  PersonalDetailsSchema,
  PersonalIdNumbersSchema,
  SubmitEmployeeTransactionRequestSchema,
  UpdateBankAccountRequestSchema,
  UpdateBeneficiariesRequestSchema,
  UpdateDriversLicenceRequestSchema,
  UpdateFamilyMemberRequestSchema,
  UpdatePersonalDetailsRequestSchema,
} from '@peoplehub/shared';
import { createZodDto } from 'nestjs-zod';
import type { SecurityContext } from '../../common/context/security-context';
import { Idempotent } from '../../common/http/idempotency';
import { Ctx } from '../../common/http/request';
import { Roles } from '../auth/decorators';
import { BankAccountService } from './bank-account.service';
import { BeneficiaryService } from './beneficiary.service';
import { ChangeRequestService } from './change-request.service';
import { DetailsAccess } from './details-records';
import { DriversLicenceService } from './drivers-licence.service';
import { EmployeeTransactionService } from './employee-transaction.service';
import { FamilyService } from './family.service';
import { PersonalDetailsService } from './personal-details.service';

class IdParamDto extends createZodDto(IdParamSchema) {}
class MembershipIdParamDto extends createZodDto(MembershipIdParamSchema) {}
class PersonalDetailsDto extends createZodDto(PersonalDetailsSchema) {}
class PersonalIdNumbersDto extends createZodDto(PersonalIdNumbersSchema) {}
class UpdatePersonalDetailsRequestDto extends createZodDto(UpdatePersonalDetailsRequestSchema) {}
class ChangeRequestSubmitResponseDto extends createZodDto(ChangeRequestSubmitResponseSchema) {}
class ChangeRequestsQueryDto extends createZodDto(ChangeRequestsQuerySchema) {}
class ChangeRequestsResponseDto extends createZodDto(ChangeRequestsResponseSchema) {}
class BankAccountsResponseDto extends createZodDto(BankAccountsResponseSchema) {}
class CreateBankAccountRequestDto extends createZodDto(CreateBankAccountRequestSchema) {}
class UpdateBankAccountRequestDto extends createZodDto(UpdateBankAccountRequestSchema) {}
class BankAccountUnmaskQueryDto extends createZodDto(BankAccountUnmaskQuerySchema) {}
class BankAccountUnmaskedDto extends createZodDto(BankAccountUnmaskedSchema) {}
class DriversLicencesResponseDto extends createZodDto(DriversLicencesResponseSchema) {}
class CreateDriversLicenceRequestDto extends createZodDto(CreateDriversLicenceRequestSchema) {}
class UpdateDriversLicenceRequestDto extends createZodDto(UpdateDriversLicenceRequestSchema) {}
class DeleteDetailRequestDto extends createZodDto(DeleteDetailRequestSchema) {}
class FamilyMembersResponseDto extends createZodDto(FamilyMembersResponseSchema) {}
class CreateFamilyMemberRequestDto extends createZodDto(CreateFamilyMemberRequestSchema) {}
class UpdateFamilyMemberRequestDto extends createZodDto(UpdateFamilyMemberRequestSchema) {}
class FundsResponseDto extends createZodDto(FundsResponseSchema) {}
class UpdateBeneficiariesRequestDto extends createZodDto(UpdateBeneficiariesRequestSchema) {}
class EmployeeTransactionsResponseDto extends createZodDto(EmployeeTransactionsResponseSchema) {}
class EmployeeTransactionDto extends createZodDto(EmployeeTransactionSchema) {}
class SubmitEmployeeTransactionRequestDto extends createZodDto(SubmitEmployeeTransactionRequestSchema) {}

/**
 * Section 12.5, My Details. `/me` is the "Working as" employee, subject to the restricted-feature
 * list. Every change answers with the ChangeRequest it created (and any warnings); nothing is
 * changed until the final approval.
 */
@ApiTags('my details')
@Controller('me')
export class DetailsController {
  constructor(
    private readonly access: DetailsAccess,
    private readonly changeRequests: ChangeRequestService,
    private readonly personal: PersonalDetailsService,
    private readonly bank: BankAccountService,
    private readonly licences: DriversLicenceService,
    private readonly family: FamilyService,
    private readonly funds: BeneficiaryService,
    private readonly transactions: EmployeeTransactionService,
  ) {}

  // ───────────── Personal details (BASICINF) ─────────────

  @Get('personal')
  @ApiOkResponse({ type: PersonalDetailsDto })
  getPersonal(@Ctx() ctx: SecurityContext): Promise<PersonalDetailsDto> {
    return this.personal.getMine(ctx);
  }

  /** The unmasked ID numbers (audited; refused while working as someone else). */
  @Get('personal/id-numbers')
  @ApiOkResponse({ type: PersonalIdNumbersDto })
  idNumbers(@Ctx() ctx: SecurityContext): Promise<PersonalIdNumbersDto> {
    return this.personal.idNumbers(ctx);
  }

  @Put('personal')
  @Idempotent()
  @ApiOkResponse({ type: ChangeRequestSubmitResponseDto })
  updatePersonal(
    @Ctx() ctx: SecurityContext,
    @Body() body: UpdatePersonalDetailsRequestDto,
  ): Promise<ChangeRequestSubmitResponseDto> {
    return this.personal.submitMine(ctx, body);
  }

  // ───────────── Bank details (BANKDET) ─────────────

  @Get('bank-accounts')
  @ApiOkResponse({ type: BankAccountsResponseDto })
  bankAccounts(@Ctx() ctx: SecurityContext): Promise<BankAccountsResponseDto> {
    return this.bank.listMine(ctx);
  }

  @Post('bank-accounts')
  @Idempotent()
  @ApiCreatedResponse({ type: ChangeRequestSubmitResponseDto })
  createBankAccount(
    @Ctx() ctx: SecurityContext,
    @Body() body: CreateBankAccountRequestDto,
  ): Promise<ChangeRequestSubmitResponseDto> {
    return this.bank.submitCreate(ctx, body);
  }

  @Put('bank-accounts/:id')
  @Idempotent()
  @ApiOkResponse({ type: ChangeRequestSubmitResponseDto })
  updateBankAccount(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: UpdateBankAccountRequestDto,
  ): Promise<ChangeRequestSubmitResponseDto> {
    return this.bank.submitUpdate(ctx, params.id, body);
  }

  /** PAYROLL_ADMIN only, with a reason; audited DATA_VIEW.BANK_ACCOUNT_UNMASKED. */
  @Get('bank-accounts/:id/unmasked')
  @Roles('PAYROLL_ADMIN')
  @ApiOkResponse({ type: BankAccountUnmaskedDto })
  unmask(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Query() query: BankAccountUnmaskQueryDto,
  ): Promise<BankAccountUnmaskedDto> {
    return this.bank.unmask(ctx, params.id, query.reason, 'ME');
  }

  // ───────────── Drivers licences (DRIVERSLICENSE) ─────────────

  @Get('drivers-licences')
  @ApiOkResponse({ type: DriversLicencesResponseDto })
  driversLicences(@Ctx() ctx: SecurityContext): Promise<DriversLicencesResponseDto> {
    return this.licences.listMine(ctx);
  }

  @Post('drivers-licences')
  @Idempotent()
  @ApiCreatedResponse({ type: ChangeRequestSubmitResponseDto })
  createDriversLicence(
    @Ctx() ctx: SecurityContext,
    @Body() body: CreateDriversLicenceRequestDto,
  ): Promise<ChangeRequestSubmitResponseDto> {
    return this.licences.submitCreate(ctx, body);
  }

  @Put('drivers-licences/:id')
  @Idempotent()
  @ApiOkResponse({ type: ChangeRequestSubmitResponseDto })
  updateDriversLicence(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: UpdateDriversLicenceRequestDto,
  ): Promise<ChangeRequestSubmitResponseDto> {
    return this.licences.submitUpdate(ctx, params.id, body);
  }

  @Delete('drivers-licences/:id')
  @Idempotent()
  @ApiOkResponse({ type: ChangeRequestSubmitResponseDto })
  deleteDriversLicence(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: DeleteDetailRequestDto,
  ): Promise<ChangeRequestSubmitResponseDto> {
    return this.licences.submitDelete(ctx, params.id, body);
  }

  // ───────────── Family (BASICINF) ─────────────

  @Get('family')
  @ApiOkResponse({ type: FamilyMembersResponseDto })
  familyMembers(@Ctx() ctx: SecurityContext): Promise<FamilyMembersResponseDto> {
    return this.family.listMine(ctx);
  }

  @Post('family')
  @Idempotent()
  @ApiCreatedResponse({ type: ChangeRequestSubmitResponseDto })
  createFamilyMember(
    @Ctx() ctx: SecurityContext,
    @Body() body: CreateFamilyMemberRequestDto,
  ): Promise<ChangeRequestSubmitResponseDto> {
    return this.family.submitCreate(ctx, body);
  }

  @Put('family/:id')
  @Idempotent()
  @ApiOkResponse({ type: ChangeRequestSubmitResponseDto })
  updateFamilyMember(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: UpdateFamilyMemberRequestDto,
  ): Promise<ChangeRequestSubmitResponseDto> {
    return this.family.submitUpdate(ctx, params.id, body);
  }

  @Delete('family/:id')
  @Idempotent()
  @ApiOkResponse({ type: ChangeRequestSubmitResponseDto })
  deleteFamilyMember(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: DeleteDetailRequestDto,
  ): Promise<ChangeRequestSubmitResponseDto> {
    return this.family.submitDelete(ctx, params.id, body);
  }

  // ───────────── Beneficiaries (BENEFICIARY) ─────────────

  @Get('funds')
  @ApiOkResponse({ type: FundsResponseDto })
  fundMemberships(@Ctx() ctx: SecurityContext): Promise<FundsResponseDto> {
    return this.funds.listMine(ctx);
  }

  @Put('funds/:membershipId/beneficiaries')
  @Idempotent()
  @ApiOkResponse({ type: ChangeRequestSubmitResponseDto })
  updateBeneficiaries(
    @Ctx() ctx: SecurityContext,
    @Param() params: MembershipIdParamDto,
    @Body() body: UpdateBeneficiariesRequestDto,
  ): Promise<ChangeRequestSubmitResponseDto> {
    return this.funds.submit(ctx, params.membershipId, body);
  }

  // ───────────── Employee transactions (FREETEXTMANEMP) ─────────────

  @Get('transactions')
  @ApiOkResponse({ type: EmployeeTransactionsResponseDto })
  employeeTransactions(@Ctx() ctx: SecurityContext): Promise<EmployeeTransactionsResponseDto> {
    return this.transactions.listMine(ctx);
  }

  @Post('transactions')
  @Idempotent()
  @ApiCreatedResponse({ type: EmployeeTransactionDto })
  submitTransaction(
    @Ctx() ctx: SecurityContext,
    @Body() body: SubmitEmployeeTransactionRequestDto,
  ): Promise<EmployeeTransactionDto> {
    return this.transactions.submit(ctx, body);
  }

  // ───────────── Change requests ─────────────

  @Get('change-requests')
  @HttpCode(200)
  @ApiOkResponse({ type: ChangeRequestsResponseDto })
  async changeRequestList(
    @Ctx() ctx: SecurityContext,
    @Query() query: ChangeRequestsQueryDto,
  ): Promise<ChangeRequestsResponseDto> {
    const me = await this.access.me(ctx);
    return this.changeRequests.list(me.id, query);
  }
}
