import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { HolidaysQuerySchema, HolidaysResponseSchema } from '@peoplehub/shared';
import { createZodDto } from 'nestjs-zod';
import type { SecurityContext } from '../../common/context/security-context';
import { Ctx } from '../../common/http/request';
import { DbService } from '../../prisma/db.service';
import { HolidayService } from './holiday.service';

class HolidaysQueryDto extends createZodDto(HolidaysQuerySchema) {}
class HolidaysResponseDto extends createZodDto(HolidaysResponseSchema) {}

/** Section 12.2: `GET /holidays?from=&to=` for the acting-as employee's company. */
@ApiTags('holidays')
@Controller('holidays')
export class HolidaysController {
  constructor(
    private readonly holidays: HolidayService,
    private readonly db: DbService,
  ) {}

  @Get()
  @ApiOkResponse({ type: HolidaysResponseDto })
  async list(@Ctx() ctx: SecurityContext, @Query() query: HolidaysQueryDto): Promise<HolidaysResponseDto> {
    const employee = await this.db.prisma.employee.findFirst({
      where: { id: ctx.actingAsEmployeeId, deletedAt: null },
      select: { companyId: true },
    });
    const companyId = employee?.companyId ?? null;
    return {
      from: query.from,
      to: query.to,
      companyId,
      items: await this.holidays.between(companyId, query.from, query.to),
    };
  }
}
