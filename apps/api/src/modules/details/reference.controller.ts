import { Controller, Get, Param } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  BankBranchesResponseSchema,
  BanksResponseSchema,
  IdParamSchema,
  LookupResponseSchema,
  LookupTableParamSchema,
} from '@peoplehub/shared';
import { createZodDto } from 'nestjs-zod';
import { BanksService } from './banks.service';
import { LookupService } from './lookup.service';

class IdParamDto extends createZodDto(IdParamSchema) {}
class LookupTableParamDto extends createZodDto(LookupTableParamSchema) {}
class LookupResponseDto extends createZodDto(LookupResponseSchema) {}
class BanksResponseDto extends createZodDto(BanksResponseSchema) {}
class BankBranchesResponseDto extends createZodDto(BankBranchesResponseSchema) {}

/** Section 12.5: the pick lists of the My Details forms (any signed-in user). */
@ApiTags('my details')
@Controller()
export class ReferenceController {
  constructor(
    private readonly lookups: LookupService,
    private readonly banks: BanksService,
  ) {}

  /** countries, languages, titles, marital, bloodGroups, religions, relationships, licenceCodes, … */
  @Get('lookups/:table')
  @ApiOkResponse({ type: LookupResponseDto })
  lookup(@Param() params: LookupTableParamDto): Promise<LookupResponseDto> {
    return this.lookups.list(params.table);
  }

  @Get('banks')
  @ApiOkResponse({ type: BanksResponseDto })
  bankList(): Promise<BanksResponseDto> {
    return this.banks.list();
  }

  @Get('banks/:id/branches')
  @ApiOkResponse({ type: BankBranchesResponseDto })
  branches(@Param() params: IdParamDto): Promise<BankBranchesResponseDto> {
    return this.banks.branches(params.id);
  }
}
