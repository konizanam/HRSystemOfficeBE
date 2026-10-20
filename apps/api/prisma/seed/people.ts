import { faker } from '@faker-js/faker';
import type { Role } from '@prisma/client';
import * as argon2 from 'argon2';
import type { SeedDeps, SeedSummary } from './index';

/**
 * The one development password of every seeded user. It meets the policy (10+ characters, 3 of 4
 * classes). The seed prints it only when NODE_ENV=development.
 */
export const SEED_DEV_PASSWORD = 'PeopleHub-Dev-2026!';

/** Fixed faker seed: the same names on every machine, and never real people. */
const FAKER_SEED = 20_261_020;

interface SeedPerson {
  username: string;
  entityCode: string;
  roles: Role[];
  /** Username of the manager (section 14: manager B reports to manager A, employees to B). */
  reportsTo: string | null;
  jobTitle?: string;
  department: string;
}

/** Section 14: one per admin role, two managers and six employees. */
export const SEED_PEOPLE: SeedPerson[] = [
  {
    username: 'manager.a',
    entityCode: '000010',
    roles: ['EMPLOYEE', 'MANAGER'],
    reportsTo: null,
    department: 'Operations',
  },
  {
    username: 'manager.b',
    entityCode: '000011',
    roles: ['EMPLOYEE', 'MANAGER'],
    reportsTo: 'manager.a',
    department: 'Operations',
  },
  {
    username: 'hr.admin',
    entityCode: '000001',
    roles: ['EMPLOYEE', 'HR_ADMIN'],
    reportsTo: 'manager.a',
    department: 'Human Resources',
  },
  {
    username: 'payroll.admin',
    entityCode: '000002',
    roles: ['EMPLOYEE', 'PAYROLL_ADMIN'],
    reportsTo: 'manager.a',
    department: 'Finance',
  },
  {
    username: 'sys.admin',
    entityCode: '000003',
    roles: ['EMPLOYEE', 'SYSTEM_ADMIN'],
    reportsTo: 'manager.a',
    department: 'Information Technology',
  },
  {
    username: 'auditor',
    entityCode: '000004',
    roles: ['EMPLOYEE', 'AUDITOR'],
    reportsTo: 'manager.a',
    department: 'Internal Audit',
  },
  // employee1 is the demo employee of the section 1.7 fixtures (reference E000077-…).
  {
    username: 'employee1',
    entityCode: '000077',
    roles: ['EMPLOYEE'],
    reportsTo: 'manager.b',
    department: 'Operations',
  },
  {
    username: 'employee2',
    entityCode: '000078',
    roles: ['EMPLOYEE'],
    reportsTo: 'manager.b',
    department: 'Operations',
  },
  {
    username: 'employee3',
    entityCode: '000079',
    roles: ['EMPLOYEE'],
    reportsTo: 'manager.b',
    department: 'Operations',
  },
  {
    username: 'employee4',
    entityCode: '000080',
    roles: ['EMPLOYEE'],
    reportsTo: 'manager.b',
    department: 'Operations',
  },
  {
    username: 'employee5',
    entityCode: '000081',
    roles: ['EMPLOYEE'],
    reportsTo: 'manager.b',
    department: 'Operations',
  },
  {
    username: 'employee6',
    entityCode: '000082',
    roles: ['EMPLOYEE'],
    reportsTo: 'manager.b',
    department: 'Operations',
  },
];

function isoDate(d: Date): Date {
  return new Date(`${d.toISOString().slice(0, 10)}T00:00:00Z`);
}

/**
 * Employees and users for section 14. Idempotent: rows are keyed on the entity code and the
 * username and are only created when missing, so a second run changes nothing (and passwords that
 * were changed in development are kept).
 */
export async function seedPeople({ db, ctx }: SeedDeps): Promise<SeedSummary> {
  faker.seed(FAKER_SEED);
  // Draw every fake value up front so the names do not depend on which rows already exist.
  const generated = SEED_PEOPLE.map(() => {
    const sex = faker.person.sexType();
    const firstName = faker.person.firstName(sex);
    return {
      firstName,
      lastName: faker.person.lastName(),
      title:
        sex === 'female'
          ? faker.helpers.arrayElement(['Ms', 'Mrs', 'Dr'])
          : faker.helpers.arrayElement(['Mr', 'Dr']),
      gender: sex === 'female' ? 'Female' : 'Male',
      jobTitle: faker.person.jobTitle(),
      dateOfBirth: isoDate(faker.date.between({ from: '1968-01-01T00:00:00Z', to: '2001-12-31T00:00:00Z' })),
      dateEngaged: isoDate(faker.date.between({ from: '2012-01-01T00:00:00Z', to: '2023-12-31T00:00:00Z' })),
    };
  });
  const passwordHash = await argon2.hash(SEED_DEV_PASSWORD, { type: argon2.argon2id });

  return db.tx(ctx, async (tx) => {
    const company = await tx.company.findUniqueOrThrow({ where: { code: 'DEMO' } });
    const rule = await tx.companyRule.findUniqueOrThrow({
      where: { companyId_code: { companyId: company.id, code: 'STAFF' } },
    });
    const employeeIds = new Map<string, number>();
    let createdUsers = 0;

    for (const [i, person] of SEED_PEOPLE.entries()) {
      const fake = generated[i] as (typeof generated)[number];
      const reportsToId = person.reportsTo ? (employeeIds.get(person.reportsTo) ?? null) : null;
      const employee = await tx.employee.upsert({
        where: { entityCode: person.entityCode },
        update: {},
        create: {
          entityCode: person.entityCode,
          employeeCode: `E${person.entityCode}`,
          companyId: company.id,
          companyRuleId: rule.id,
          title: fake.title,
          initials: fake.firstName.charAt(0),
          firstName: fake.firstName,
          lastName: fake.lastName,
          knownAs: fake.firstName,
          gender: fake.gender,
          dateOfBirth: fake.dateOfBirth,
          dateEngaged: fake.dateEngaged,
          jobTitle: fake.jobTitle,
          department: person.department,
          reportsToId,
          nationality: 'NA',
        },
      });
      employeeIds.set(person.username, employee.id);

      const existing = await tx.user.findUnique({ where: { username: person.username } });
      if (!existing) {
        const user = await tx.user.create({
          data: {
            username: person.username,
            email: `${person.username}@peoplehub.example`,
            passwordHash,
            roles: person.roles,
            employeeId: employee.id,
            passwordChangedAt: new Date(),
          },
        });
        await tx.passwordHistory.create({ data: { userId: user.id, hash: passwordHash } });
        createdUsers += 1;
      }
    }
    return { people: SEED_PEOPLE.length, usersCreated: createdUsers };
  });
}
