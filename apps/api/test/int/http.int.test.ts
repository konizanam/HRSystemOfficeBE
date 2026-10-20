import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../support/app';

describe('HTTP foundation', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('serves liveness and readiness outside /api/v1', async () => {
    await request(t.server).get('/health').expect(200, { status: 'ok' });
    const ready = await request(t.server).get('/ready').expect(200);
    expect(ready.body.db).toBe('ok');
  });

  it('exposes Prometheus metrics', async () => {
    const res = await request(t.server).get('/metrics').expect(200);
    expect(res.text).toContain('http_request_duration_seconds');
    expect(res.text).toContain('audit_insert_duration_seconds');
  });

  it('returns problem+json with a request id for unknown routes', async () => {
    const res = await request(t.server)
      .get('/api/v1/does-not-exist')
      .set('x-request-id', 'req-123')
      .expect(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.headers['x-request-id']).toBe('req-123');
    expect(res.body).toMatchObject({ status: 404, title: 'Not Found', requestId: 'req-123' });
  });

  it('sends security headers', async () => {
    const res = await request(t.server).get('/health');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('same-origin');
    expect(res.headers['strict-transport-security']).toContain('max-age');
  });

  it('publishes the OpenAPI document', async () => {
    const res = await request(t.server).get('/api/docs/openapi.json').expect(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.info.title).toBe('PeopleHub ESS API');
  });
});
