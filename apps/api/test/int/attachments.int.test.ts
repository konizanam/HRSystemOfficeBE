import { ATTACHMENT_PROBLEM_TYPES } from '@peoplehub/shared';
import { createServer, type Server } from 'node:net';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetEnvCache } from '../../src/config/env';
import { startTestApp, type TestApp } from '../support/app';
import {
  type Agent,
  auditSince,
  createRoleFixtures,
  lastAuditId,
  login,
  type RoleFixtures,
} from '../support/fixtures';
import { LEAVE_TYPE, LeaveKit, PDF_BYTES } from '../support/leave';
import { WorkflowKit } from '../support/workflow';

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
]);
const EICAR = Buffer.from(
  '%PDF-1.4 X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
  'latin1',
);

/** A minimal clamd: answers INSTREAM with FOUND when the stream contains the EICAR marker. */
function fakeClamd(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        const all = Buffer.concat(chunks);
        if (all.length >= 14 && all.subarray(all.length - 4).equals(Buffer.alloc(4))) {
          socket.end(
            all.includes(Buffer.from('EICAR')) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0',
          );
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0 });
    });
  });
}

describe('attachments (section 10.4)', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let kit: WorkflowKit;
  let leave: LeaveKit;
  let clamd: { server: Server; port: number };
  let emp: Agent;
  const previous = { scanner: process.env.VIRUS_SCANNER, port: process.env.CLAMAV_PORT };

  beforeAll(async () => {
    clamd = await fakeClamd();
    process.env.VIRUS_SCANNER = 'clamav';
    process.env.CLAMAV_HOST = '127.0.0.1';
    process.env.CLAMAV_PORT = String(clamd.port);
    resetEnvCache();
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    kit = new WorkflowKit(t);
    leave = new LeaveKit(t, kit);
    await leave.setup(f.org);
    await leave.accrue([f.employee.employeeId]);
    emp = await login(t, f.employee);
  });

  afterAll(async () => {
    kit.restore();
    await t.close();
    clamd.server.close();
    process.env.VIRUS_SCANNER = previous.scanner ?? 'none';
    process.env.CLAMAV_PORT = previous.port ?? '3310';
    resetEnvCache();
  });

  it('stores a checked upload as unowned, with its sha256, under yyyy/mm/{uuid}', async () => {
    const since = await lastAuditId(t.db);
    const res = await emp
      .post('/attachments')
      .attach('file', PDF_BYTES, { filename: 'note.pdf', contentType: 'application/pdf' });
    expect(res.status, res.text).toBe(201);
    const item = res.body.items[0];
    expect(item).toMatchObject({
      fileName: 'note.pdf',
      mimeType: 'application/pdf',
      sizeBytes: PDF_BYTES.length,
      sha256: createHash('sha256').update(PDF_BYTES).digest('hex'),
      ownerEntity: 'Unowned',
      isBound: false,
      downloadUrl: `/api/v1/attachments/${item.id}`,
    });
    const row = await t.db.prisma.attachment.findUniqueOrThrow({ where: { id: item.id } });
    expect(row.storageKey).toMatch(new RegExp(`^\\d{4}/\\d{2}/${item.id}$`));
    expect(row.ownerEntityId).toBe(f.employee.userId);
    const audit = await auditSince(t.db, since, { action: 'ATTACHMENT.UPLOADED' });
    expect(audit[0]?.after).toEqual({
      id: item.id,
      fileName: 'note.pdf',
      sha256: row.sha256,
      sizeBytes: row.sizeBytes,
      mimeType: 'application/pdf',
      ownerEntity: 'Unowned',
      ownerEntityId: f.employee.userId,
    });
    // Several files in one request.
    const two = await emp
      .post('/attachments')
      .attach('file', PDF_BYTES, { filename: 'a.pdf', contentType: 'application/pdf' })
      .attach('file', PNG, { filename: 'b.png', contentType: 'image/png' });
    expect(two.status).toBe(201);
    expect(two.body.items.map((i: { mimeType: string }) => i.mimeType)).toEqual([
      'application/pdf',
      'image/png',
    ]);
  });

  it('rejects files whose bytes do not match their type, wrong extensions, empty and oversized files', async () => {
    const renamed = await emp.post('/attachments').attach('file', Buffer.from('MZ\x90\x00\x03 not a pdf'), {
      filename: 'invoice.pdf',
      contentType: 'application/pdf',
    });
    expect(renamed.status).toBe(422);
    expect(renamed.body.type).toBe(ATTACHMENT_PROBLEM_TYPES.invalidType);
    const mismatch = await emp
      .post('/attachments')
      .attach('file', PNG, { filename: 'scan.pdf', contentType: 'image/png' });
    expect(mismatch.status).toBe(422);
    const exe = await emp
      .post('/attachments')
      .attach('file', PDF_BYTES, { filename: 'tool.exe', contentType: 'application/pdf' });
    expect(exe.status).toBe(422);
    const empty = await emp
      .post('/attachments')
      .attach('file', Buffer.alloc(0), { filename: 'empty.pdf', contentType: 'application/pdf' });
    expect(empty.status).toBe(422);
    const big = Buffer.concat([PDF_BYTES, Buffer.alloc(10 * 1024 * 1024)]);
    const large = await emp
      .post('/attachments')
      .attach('file', big, { filename: 'big.pdf', contentType: 'application/pdf' });
    expect(large.status).toBe(413);
    expect(large.body.type).toBe(ATTACHMENT_PROBLEM_TYPES.tooLarge);
    await emp.post('/attachments').send({ file: 'x' }).expect(415);
  });

  it('rejects an infected file reported by ClamAV and audits it', async () => {
    const since = await lastAuditId(t.db);
    const res = await emp
      .post('/attachments')
      .attach('file', EICAR, { filename: 'eicar.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(422);
    expect(res.body.type).toBe(ATTACHMENT_PROBLEM_TYPES.infected);
    const rows = await auditSince(t.db, since, { action: 'ATTACHMENT.REJECTED_INFECTED' });
    expect(rows[0]).toMatchObject({ outcome: 'FAILURE', reason: 'Eicar-Test-Signature' });
    expect(
      await t.db.prisma.attachment.count({
        where: { fileName: 'eicar.pdf', uploadedByUserId: f.employee.userId },
      }),
    ).toBe(0);
  });

  it('lets only the uploader see and remove an unsubmitted upload', async () => {
    const id = await leave.upload(emp, 'draft.pdf');
    const own = await emp.get(`/attachments/${id}`);
    expect(own.status).toBe(200);
    expect(own.headers['content-type']).toBe('application/pdf');
    expect(own.headers['content-disposition']).toContain('draft.pdf');
    await (await login(t, f.hrAdmin)).get(`/attachments/${id}`).expect(403);
    await (await login(t, f.employee2)).delete(`/attachments/${id}`).expect(403);
    await emp.delete(`/attachments/${id}`).expect(204);
    await emp.get(`/attachments/${id}`).expect(404);
  });

  it('authorises downloads against the owning leave application and audits them', async () => {
    const range = await leave.range(await leave.monday(21, f.org.companyId), 3, f.org.companyId);
    const reason = await t.db.prisma.leaveReason.findUniqueOrThrow({
      where: { leaveTypeId_code: { leaveTypeId: LEAVE_TYPE.sick, code: 'ILLNESS' } },
    });
    const id = await leave.upload(emp, 'medical-certificate.pdf');
    const app = await leave.submit(emp, {
      leaveTypeId: LEAVE_TYPE.sick,
      ...range,
      leaveReasonId: reason.id,
      attachmentIds: [id],
    });
    // The approver's inbox detail links to the audited download.
    const mgr = await login(t, f.managerB);
    const detail = (await mgr.get(`/inbox/items/${app.processId}`).expect(200)).body;
    expect(detail.attachments.map((a: { id: string; downloadUrl: string }) => [a.id, a.downloadUrl])).toEqual(
      [[id, `/api/v1/attachments/${id}`]],
    );

    const allowed = ['employee', 'managerB', 'hrAdmin', 'payrollAdmin', 'auditor'] as const;
    for (const key of allowed) {
      const agent = key === 'employee' ? emp : key === 'managerB' ? mgr : await login(t, f[key]);
      const since = await lastAuditId(t.db);
      const res = await agent.get(`/attachments/${id}`);
      expect(res.status, `${key}: ${res.text}`).toBe(200);
      expect(Buffer.from(res.body as Buffer).equals(PDF_BYTES)).toBe(true);
      const rows = await auditSince(t.db, since, { action: 'DATA_VIEW.ATTACHMENT_DOWNLOAD' });
      expect(rows[0]).toMatchObject({
        entityType: 'Attachment',
        entityId: id,
        subjectEmployeeId: f.employee.employeeId,
      });
      expect(rows[0]?.metadata).toMatchObject({
        fileName: 'medical-certificate.pdf',
        ownerEntity: 'LeaveApplication',
      });
    }
    for (const key of ['employee2', 'unrelated', 'sysAdmin', 'otherCompany'] as const) {
      const agent = await login(t, f[key]);
      const since = await lastAuditId(t.db);
      const res = await agent.get(`/attachments/${id}`);
      expect(res.status, key).toBe(403);
      const rows = await auditSince(t.db, since, { requestId: res.headers['x-request-id'] as string });
      expect(rows.map((r) => r.outcome)).toEqual(['DENIED']);
    }
    // A bound file can no longer be removed.
    await emp.delete(`/attachments/${id}`).expect(403);
    await emp.get('/attachments/5f7c2b8e-3c1a-4c55-9d7e-0a1b2c3d4e5f').expect(404);
    await emp.get('/attachments/not-a-uuid').expect(422);
  });
});
