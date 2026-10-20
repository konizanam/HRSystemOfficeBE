import type { MultipartFile } from '@fastify/multipart';
import { Controller, Delete, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import { ApiConsumes, ApiCreatedResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
import {
  ATTACHMENT_MAX_FILES_PER_UPLOAD,
  ATTACHMENT_PROBLEM_TYPES,
  ATTACHMENT_UPLOAD_FIELD,
  AttachmentIdSchema,
  UploadAttachmentsResponseSchema,
} from '@peoplehub/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { SecurityContext } from '../../common/context/security-context';
import { DomainError } from '../../common/errors/domain-errors';
import { Ctx } from '../../common/http/request';
import { AttachmentService, type IncomingFile } from './attachment.service';

class AttachmentIdParamDto extends createZodDto(z.object({ id: AttachmentIdSchema })) {}
class UploadAttachmentsResponseDto extends createZodDto(UploadAttachmentsResponseSchema) {}

/** Multipart errors raised by @fastify/multipart while reading the body. */
function multipartError(err: unknown): DomainError | null {
  const code = (err as { code?: unknown })?.code;
  if (code === 'FST_REQ_FILE_TOO_LARGE') {
    return new DomainError(
      413,
      'Payload Too Large',
      'A file is larger than 10 MB',
      [{ path: 'file', message: 'Files can be at most 10 MB' }],
      ATTACHMENT_PROBLEM_TYPES.tooLarge,
    );
  }
  if (code === 'FST_FILES_LIMIT' || code === 'FST_PARTS_LIMIT') {
    return new DomainError(
      413,
      'Payload Too Large',
      `Upload at most ${ATTACHMENT_MAX_FILES_PER_UPLOAD} files at a time`,
      [{ path: 'file', message: `Upload at most ${ATTACHMENT_MAX_FILES_PER_UPLOAD} files at a time` }],
      ATTACHMENT_PROBLEM_TYPES.tooLarge,
    );
  }
  return null;
}

/** RFC 6266 Content-Disposition with an ASCII fallback and the UTF-8 name. */
function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * Section 10.4: `POST /attachments` (multipart, field `file`, one or more files),
 * `GET /attachments/:id` (authorised against the owning entity, audited) and
 * `DELETE /attachments/:id` (an upload that has not been submitted, by its uploader).
 */
@ApiTags('attachments')
@Controller('attachments')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentService) {}

  @Post()
  @ApiConsumes('multipart/form-data')
  @ApiCreatedResponse({ type: UploadAttachmentsResponseDto })
  async upload(
    @Ctx() ctx: SecurityContext,
    @Req() req: FastifyRequest,
  ): Promise<UploadAttachmentsResponseDto> {
    if (!req.isMultipart()) {
      throw new DomainError(
        415,
        'Unsupported Media Type',
        'Send the files as multipart/form-data',
        [{ path: 'file', message: 'Send the files as multipart/form-data' }],
        ATTACHMENT_PROBLEM_TYPES.invalidType,
      );
    }
    const files: IncomingFile[] = [];
    try {
      for await (const part of req.parts()) {
        if (part.type !== 'file') continue;
        const file = part as MultipartFile;
        if (file.fieldname !== ATTACHMENT_UPLOAD_FIELD) {
          await file.toBuffer();
          continue;
        }
        files.push({ fileName: file.filename, mimeType: file.mimetype, bytes: await file.toBuffer() });
      }
    } catch (err) {
      throw multipartError(err) ?? err;
    }
    return { items: await this.attachments.upload(ctx, files) };
  }

  @Get(':id')
  @ApiProduces('application/octet-stream')
  async download(
    @Ctx() ctx: SecurityContext,
    @Param() params: AttachmentIdParamDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const file = await this.attachments.download(ctx, params.id);
    await reply
      .header('content-type', file.mimeType)
      .header('content-disposition', contentDisposition(file.fileName))
      .header('cache-control', 'private, no-store')
      .header('content-length', String(file.bytes.length))
      .send(file.bytes);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Ctx() ctx: SecurityContext, @Param() params: AttachmentIdParamDto): Promise<void> {
    await this.attachments.remove(ctx, params.id);
  }
}
