import { Injectable } from '@nestjs/common';
import {
  addDays,
  birthdayDayMonth,
  birthdayLabel,
  businessFromDate,
  daysUntilBirthday,
  isBirthdayWithin,
  todayBusinessDate,
  type UpcomingBirthday,
  type UpcomingBirthdaysResponse,
} from '@peoplehub/shared';
import type { SecurityContext } from '../../common/context/security-context';
import { DbService } from '../../prisma/db.service';
import { SettingsService } from '../settings/settings.service';

/**
 * Upcoming birthdays (section 5.1.6): colleagues in the acting-as employee's company rule whose
 * birthday falls today or within the next `days` days. Only the name and the day and month leave
 * the server, never the year. Employees who opted out (`birthdayVisible = false`) and terminated
 * or deleted employees are left out; `birthdays.enabled = false` turns the list off.
 */
@Injectable()
export class BirthdayService {
  constructor(
    private readonly db: DbService,
    private readonly settings: SettingsService,
  ) {}

  async upcoming(
    ctx: SecurityContext,
    days: number,
    today = todayBusinessDate(),
  ): Promise<UpcomingBirthdaysResponse> {
    const empty = (enabled: boolean): UpcomingBirthdaysResponse => ({
      enabled,
      days,
      from: today,
      to: addDays(today, days),
      count: 0,
      items: [],
    });
    if (!(await this.settings.get('birthdays.enabled'))) return empty(false);
    if (!ctx.actingAsEmployeeId) return empty(true);
    const subject = await this.db.prisma.employee.findFirst({
      where: { id: ctx.actingAsEmployeeId, deletedAt: null },
      select: { companyRuleId: true },
    });
    if (!subject) return empty(true);
    const people = await this.db.prisma.employee.findMany({
      where: {
        companyRuleId: subject.companyRuleId,
        deletedAt: null,
        status: { not: 'TERMINATED' },
        birthdayVisible: true,
        dateOfBirth: { not: null },
      },
      select: { id: true, firstName: true, lastName: true, knownAs: true, dateOfBirth: true },
    });
    const items: UpcomingBirthday[] = [];
    for (const p of people) {
      if (!p.dateOfBirth) continue;
      const dob = businessFromDate(p.dateOfBirth);
      if (!isBirthdayWithin(dob, today, days)) continue;
      const inDays = daysUntilBirthday(dob, today);
      items.push({
        employeeId: p.id,
        name: `${p.knownAs ?? p.firstName} ${p.lastName}`,
        ...birthdayDayMonth(dob),
        label: birthdayLabel(dob),
        inDays,
        isToday: inDays === 0,
      });
    }
    items.sort((a, b) => a.inDays - b.inDays || a.name.localeCompare(b.name));
    return { ...empty(true), count: items.length, items };
  }
}
