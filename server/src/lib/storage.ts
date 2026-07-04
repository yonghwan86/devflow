import fs from "node:fs/promises";
import path from "node:path";
import { env } from "./env.ts";

// Vendor-independent storage: swap implementation, keep the interface (§3).
export interface StorageAdapter {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  // Returns a presigned URL, or null if this driver requires app-streamed downloads.
  presignGet(key: string, filename: string): Promise<string | null>;
}

class LocalStorage implements StorageAdapter {
  private dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  private p(key: string) {
    return path.join(this.dir, key);
  }
  async put(key: string, body: Buffer) {
    const full = this.p(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body);
  }
  async get(key: string) {
    return fs.readFile(this.p(key));
  }
  async delete(key: string) {
    await fs.rm(this.p(key), { force: true });
  }
  async presignGet() {
    return null; // local -> stream through the app (authorized)
  }
}

class S3Storage implements StorageAdapter {
  private client: any;
  private ready: Promise<void>;
  constructor() {
    this.ready = this.init();
  }
  private async init() {
    const { S3Client } = await import("@aws-sdk/client-s3");
    this.client = new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
    });
  }
  async put(key: string, body: Buffer, contentType: string) {
    await this.ready;
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await this.client.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: body, ContentType: contentType }));
  }
  async get(key: string) {
    await this.ready;
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const res = await this.client.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    const chunks: Buffer[] = [];
    for await (const c of res.Body as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  }
  async delete(key: string) {
    await this.ready;
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    await this.client.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
  }
  // Presigned GET with forced attachment disposition (§10.6). Short-lived.
  async presignGet(key: string, filename: string) {
    await this.ready;
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    const cmd = new GetObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${encodeURIComponent(filename)}"`,
    });
    return getSignedUrl(this.client, cmd, { expiresIn: 300 });
  }
}

let _storage: StorageAdapter | null = null;
export function getStorage(): StorageAdapter {
  if (_storage) return _storage;
  _storage = env.STORAGE_DRIVER === "s3" ? new S3Storage() : new LocalStorage(env.LOCAL_STORAGE_DIR);
  return _storage;
}
// For tests: force local driver into a temp dir.
export function setStorageForTest(adapter: StorageAdapter) {
  _storage = adapter;
}
export { LocalStorage };
