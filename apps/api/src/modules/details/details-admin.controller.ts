import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  AdminBankAccountsResponseSchema,
  AdminBankBranchesResponseSchema,
  AdminBankBranchSchema,
  AdminBankSchema,
  AdminBanksResponseSchema,
  AdminFundMembershipSchema,
  AdminLookupResponseSchema,
  AdminLookupValueSchema,
  AdminPersonalDetailsUpdateResponseSchema,
  AdminRetirementFundSchema,
  AdminRetirementFundsResponseSchema,
  AdminTransactionCodeSchema,
  AdminTransactionCodesResponseSchema,
  BankAccountUnmaskedSchema,
  BankAccountUnmaskQuerySchema,
  BankBranchParamSchema,
  CreateBankBranchRequestSchema,
  CreateBankRequestSchema,
  CreateFundMembershipRequestSchema,
  CreateLookupValueRequestSchema,
  CreateRetirementFundRequestSchema,
  CreateTransactionCodeRequestSchema,
  IdParamSchema,
  LookupTableParamSchema,
  LookupValueParamSchema,
  PersonalDetailsSchema,
  UpdateBankBranchRequestSchema,
  UpdateBankRequestSchema,
  UpdateLookupValueRequestSchema,
  UpdatePersonalDetailsRequestSchema,
  UpdateRetirementFundRequestSchema,
  UpdateTransactionCodeRequestSchema,
  VersionSchema,
} from '@peoplehub/shared';
import { createZodDto } from 'nestjs-zod';
import type { SecurityContext } from '../../common/context/security-context';
import { Ctx } from '../../common/http/request';
import { Roles } from '../auth/decorators';
import { BankAccountService } from './bank-account.service';
import { BanksService } from './banks.service';
import { BeneficiaryService } from './beneficiary.service';
import { EmployeeTransactionService } from './employee-transaction.service';
import { LookupService } from './lookup.service';
import { PersonalDetailsService } from './personal-details.service';

class IdParamDto extends createZodDto(IdParamSchema) {}
class VersionDto extends createZodDto(VersionSchema) {}
class PersonalDetailsDto extends createZodDto(PersonalDetailsSchema) {}
class UpdatePersonalDetailsRequestDto extends createZodDto(UpdatePersonalDetailsRequestSchema) {}
class AdminPersonalDetailsUpdateResponseDto extends createZodDto(AdminPersonalDetailsUpdateResponseSchema) {}
class AdminBankAccountsResponseDto extends createZodDto(AdminBankAccountsResponseSchema) {}
class BankAccountUnmaskQueryDto extends createZodDto(BankAccountUnmaskQuerySchema) {}
class BankAccountUnmaskedDto extends createZodDto(BankAccountUnmaskedSchema) {}
class AdminBanksResponseDto extends createZodDto(AdminBanksResponseSchema) {}
class AdminBankDto extends createZodDto(AdminBankSchema) {}
class CreateBankRequestDto extends createZodDto(CreateBankRequestSchema) {}
class UpdateBankRequestDto extends createZodDto(UpdateBankRequestSchema) {}
class BankBranchParamDto extends createZodDto(BankBranchParamSchema) {}
class AdminBankBranchesResponseDto extends createZodDto(AdminBankBranchesResponseSchema) {}
class AdminBankBranchDto extends createZodDto(AdminBankBranchSchema) {}
class CreateBankBranchRequestDto extends createZodDto(CreateBankBranchRequestSchema) {}
class UpdateBankBranchRequestDto extends createZodDto(UpdateBankBranchRequestSchema) {}
class AdminRetirementFundsResponseDto extends createZodDto(AdminRetirementFundsResponseSchema) {}
class AdminRetirementFundDto extends createZodDto(AdminRetirementFundSchema) {}
class CreateRetirementFundRequestDto extends createZodDto(CreateRetirementFundRequestSchema) {}
class UpdateRetirementFundRequestDto extends createZodDto(UpdateRetirementFundRequestSchema) {}
class CreateFundMembershipRequestDto extends createZodDto(CreateFundMembershipRequestSchema) {}
class AdminFundMembershipDto extends createZodDto(AdminFundMembershipSchema) {}
class LookupTableParamDto extends createZodDto(LookupTableParamSchema) {}
class LookupValueParamDto extends createZodDto(LookupValueParamSchema) {}
class AdminLookupResponseDto extends createZodDto(AdminLookupResponseSchema) {}
class AdminLookupValueDto extends createZodDto(AdminLookupValueSchema) {}
class CreateLookupValueRequestDto extends createZodDto(CreateLookupValueRequestSchema) {}
class UpdateLookupValueRequestDto extends createZodDto(UpdateLookupValueRequestSchema) {}
class AdminTransactionCodesResponseDto extends createZodDto(AdminTransactionCodesResponseSchema) {}
class AdminTransactionCodeDto extends createZodDto(AdminTransactionCodeSchema) {}
class CreateTransactionCodeRequestDto extends createZodDto(CreateTransactionCodeRequestSchema) {}
class UpdateTransactionCodeRequestDto extends createZodDto(UpdateTransactionCodeRequestSchema) {}

/**
 * Section 12.10 for My Details: HR views and edits personal details directly (the same domain
 * service as approved change requests), the masked bank grid and the payroll unmask, and the
 * reference data HR keeps (banks and branches, retirement funds and memberships, the lookup
 * lists, the transaction codes employees may submit). Deleting deactivates.
 */
@ApiTags('admin: my details')
@Controller('admin')
export class DetailsAdminController {
  constructor(
    private readonly personal: PersonalDetailsService,
    private readonly bankAccounts: BankAccountService,
    private readonly banks: BanksService,
    private readonly funds: BeneficiaryService,
    private readonly lookups: LookupService,
    private readonly transactions: EmployeeTransactionService,
  ) {}

  // ───────────── Employees ─────────────

  /** Audited DATA_VIEW.PERSONAL_DETAILS. */
  @Get('employees/:id/personal')
  @Roles('HR_ADMIN', 'PAYROLL_ADMIN')
  @ApiOkResponse({ type: PersonalDetailsDto })
  getPersonal(@Ctx() ctx: SecurityContext, @Param() params: IdParamDto): Promise<PersonalDetailsDto> {
    return this.personal.getForAdmin(ctx, params.id);
  }

  @Put('employees/:id/personal')
  @Roles('HR_ADMIN')
  @ApiOkResponse({ type: AdminPersonalDetailsUpdateResponseDto })
  updatePersonal(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: UpdatePersonalDetailsRequestDto,
  ): Promise<AdminPersonalDetailsUpdateResponseDto> {
    return this.personal.updateAsHr(ctx, params.id, body);
  }

  @Get('employees/:id/bank-accounts')
  @Roles('HR_ADMIN', 'PAYROLL_ADMIN')
  @ApiOkResponse({ type: AdminBankAccountsResponseDto })
  employeeBankAccounts(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
  ): Promise<AdminBankAccountsResponseDto> {
    return this.bankAccounts.listForAdmin(ctx, params.id);
  }

  @Get('bank-accounts/:id/unmasked')
  @Roles('PAYROLL_ADMIN')
  @ApiOkResponse({ type: BankAccountUnmaskedDto })
  unmask(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Query() query: BankAccountUnmaskQueryDto,
  ): Promise<BankAccountUnmaskedDto> {
    return this.bankAccounts.unmask(ctx, params.id, query.reason, 'ADMIN');
  }

  // ───────────── Banks and branches ─────────────

  @Get('banks')
  @Roles('HR_ADMIN', 'PAYROLL_ADMIN')
  @ApiOkResponse({ type: AdminBanksResponseDto })
  bankList(): Promise<AdminBanksResponseDto> {
    return this.banks.adminList();
  }

  @Post('banks')
  @Roles('HR_ADMIN', 'PAYROLL_ADMIN')
  @ApiCreatedResponse({ type: AdminBankDto })
  createBank(@Ctx() ctx: SecurityContext, @Body() body: CreateBankRequestDto): Promise<AdminBankDto> {
    return this.banks.create(ctx, body);
  }

  @Put('banks/:id')
  @Roles('HR_ADMIN', 'PAYROLL_ADMIN')
  @ApiOkResponse({ type: AdminBankDto })
  updateBank(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: UpdateBankRequestDto,
  ): Promise<AdminBankDto> {
    return this.banks.update(ctx, params.id, body);
  }

  @Delete('banks/:id')
  @Roles('HR_ADMIN', 'PAYROLL_ADMIN')
  @ApiOkResponse({ type: AdminBankDto })
  deactivateBank(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: VersionDto,
  ): Promise<AdminBankDto> {
    return this.banks.update(ctx, params.id, { version: body.version, isActive: false });
  }

  @Get('banks/:id/branches')
  @Roles('HR_ADMIN', 'PAYROLL_ADMIN')
  @ApiOkResponse({ type: AdminBankBranchesResponseDto })
  branchList(@Param() params: IdParamDto): Promise<AdminBankBranchesResponseDto> {
    return this.banks.adminBranches(params.id);
  }

  @Post('banks/:id/branches')
  @Roles('HR_ADMIN', 'PAYROLL_ADMIN')
  @ApiCreatedResponse({ type: AdminBankBranchDto })
  createBranch(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: CreateBankBranchRequestDto,
  ): Promise<AdminBankBranchDto> {
    return this.banks.createBranch(ctx, params.id, body);
  }

  @Put('banks/:id/branches/:branchId')
  @Roles('HR_ADMIN', 'PAYROLL_ADMIN')
  @ApiOkResponse({ type: AdminBankBranchDto })
  updateBranch(
    @Ctx() ctx: SecurityContext,
    @Param() params: BankBranchParamDto,
    @Body() body: UpdateBankBranchRequestDto,
  ): Promise<AdminBankBranchDto> {
    return this.banks.updateBranch(ctx, params.id, params.branchId, body);
  }

  @Delete('banks/:id/branches/:branchId')
  @Roles('HR_ADMIN', 'PAYROLL_ADMIN')
  @ApiOkResponse({ type: AdminBankBranchDto })
  deactivateBranch(
    @Ctx() ctx: SecurityContext,
    @Param() params: BankBranchParamDto,
    @Body() body: VersionDto,
  ): Promise<AdminBankBranchDto> {
    return this.banks.updateBranch(ctx, params.id, params.branchId, {
      version: body.version,
      isActive: false,
    });
  }

  // ───────────── Retirement funds ─────────────

  @Get('retirement-funds')
  @Roles('HR_ADMIN')
  @ApiOkResponse({ type: AdminRetirementFundsResponseDto })
  fundList(): Promise<AdminRetirementFundsResponseDto> {
    return this.funds.adminList();
  }

  @Post('retirement-funds')
  @Roles('HR_ADMIN')
  @ApiCreatedResponse({ type: AdminRetirementFundDto })
  createFund(
    @Ctx() ctx: SecurityContext,
    @Body() body: CreateRetirementFundRequestDto,
  ): Promise<AdminRetirementFundDto> {
    return this.funds.createFund(ctx, body);
  }

  @Put('retirement-funds/:id')
  @Roles('HR_ADMIN')
  @ApiOkResponse({ type: AdminRetirementFundDto })
  updateFund(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: UpdateRetirementFundRequestDto,
  ): Promise<AdminRetirementFundDto> {
    return this.funds.updateFund(ctx, params.id, body);
  }

  @Delete('retirement-funds/:id')
  @Roles('HR_ADMIN')
  @ApiOkResponse({ type: AdminRetirementFundDto })
  deactivateFund(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: VersionDto,
  ): Promise<AdminRetirementFundDto> {
    return this.funds.updateFund(ctx, params.id, { version: body.version, isActive: false });
  }

  @Post('retirement-funds/:id/memberships')
  @Roles('HR_ADMIN')
  @ApiCreatedResponse({ type: AdminFundMembershipDto })
  addMembership(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: CreateFundMembershipRequestDto,
  ): Promise<AdminFundMembershipDto> {
    return this.funds.addMembership(ctx, params.id, body);
  }

  // ───────────── Lookup lists ─────────────

  @Get('lookups/:table')
  @Roles('HR_ADMIN')
  @ApiOkResponse({ type: AdminLookupResponseDto })
  lookupList(@Param() params: LookupTableParamDto): Promise<AdminLookupResponseDto> {
    return this.lookups.adminList(params.table);
  }

  @Post('lookups/:table')
  @Roles('HR_ADMIN')
  @ApiCreatedResponse({ type: AdminLookupValueDto })
  createLookup(
    @Ctx() ctx: SecurityContext,
    @Param() params: LookupTableParamDto,
    @Body() body: CreateLookupValueRequestDto,
  ): Promise<AdminLookupValueDto> {
    return this.lookups.create(ctx, params.table, body);
  }

  @Put('lookups/:table/:id')
  @Roles('HR_ADMIN')
  @ApiOkResponse({ type: AdminLookupValueDto })
  updateLookup(
    @Ctx() ctx: SecurityContext,
    @Param() params: LookupValueParamDto,
    @Body() body: UpdateLookupValueRequestDto,
  ): Promise<AdminLookupValueDto> {
    return this.lookups.update(ctx, params.table, params.id, body);
  }

  // ───────────── Transaction codes (employee inputs) ─────────────

  @Get('transaction-codes')
  @Roles('HR_ADMIN')
  @ApiOkResponse({ type: AdminTransactionCodesResponseDto })
  transactionCodes(): Promise<AdminTransactionCodesResponseDto> {
    return this.transactions.adminCodes();
  }

  @Post('transaction-codes')
  @Roles('HR_ADMIN')
  @ApiCreatedResponse({ type: AdminTransactionCodeDto })
  createTransactionCode(
    @Ctx() ctx: SecurityContext,
    @Body() body: CreateTransactionCodeRequestDto,
  ): Promise<AdminTransactionCodeDto> {
    return this.transactions.createCode(ctx, body);
  }

  @Put('transaction-codes/:id')
  @Roles('HR_ADMIN')
  @ApiOkResponse({ type: AdminTransactionCodeDto })
  updateTransactionCode(
    @Ctx() ctx: SecurityContext,
    @Param() params: IdParamDto,
    @Body() body: UpdateTransactionCodeRequestDto,
  ): Promise<AdminTransactionCodeDto> {
    return this.transactions.updateCode(ctx, params.id, body);
  }
}
