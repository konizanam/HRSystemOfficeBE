import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { env } from '../config/env';

/** Section 2/10.4: file storage behind an interface, with local-disk and S3 implementations. */
export interface StorageDriver {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  /** Only used to roll back an upload whose DB transaction failed. */
  remove(key: string): Promise<void>;
}

export class LocalDiskStorage implements StorageDriver {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(key: string): string {
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new Error('Invalid storage key');
    return full;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const full = this.pathFor(key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body, { flag: 'wx' });
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  async remove(key: string): Promise<void> {
    const { rm } = await import('node:fs/promises');
    await rm(this.pathFor(key), { force: true });
  }
}

export class S3Storage implements StorageDriver {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!out.Body) throw new Error(`Object ${key} has no body`);
    return Buffer.from(await out.Body.transformToByteArray());
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: 'bytes=0-0' }));
      return true;
    } catch {
      return false;
    }
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export function s3ClientFromEnv(): S3Client {
  const e = env();
  return new S3Client({
    region: e.S3_REGION,
    endpoint: e.S3_ENDPOINT || undefined,
    forcePathStyle: e.S3_FORCE_PATH_STYLE,
    credentials:
      e.S3_ACCESS_KEY_ID && e.S3_SECRET_ACCESS_KEY
        ? { accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY }
        : undefined,
  });
}

@Injectable()
export class StorageService implements StorageDriver {
  private readonly driver: StorageDriver;

  constructor() {
    const e = env();
    this.driver =
      e.STORAGE_DRIVER === 's3'
        ? new S3Storage(s3ClientFromEnv(), e.S3_BUCKET)
        : new LocalDiskStorage(e.STORAGE_LOCAL_ROOT);
  }

  /** Storage keys are `yyyy/mm/{uuid}` (section 10.4). */
  static keyFor(id: string, now = new Date()): string {
    return `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}`;
  }

  put(key: string, body: Buffer, contentType: string): Promise<void> {
    return this.driver.put(key, body, contentType);
  }

  get(key: string): Promise<Buffer> {
    return this.driver.get(key);
  }

  exists(key: string): Promise<boolean> {
    return this.driver.exists(key);
  }

  remove(key: string): Promise<void> {
    return this.driver.remove(key);
  }
}
