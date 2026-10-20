import { Injectable, Module } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PassThrough, type Readable } from 'node:stream';
import PdfPrinter from 'pdfmake';
import vfs from 'pdfmake/build/vfs_fonts';
import type { TDocumentDefinitions, TFontDictionary } from 'pdfmake/interfaces';

/**
 * Server-side PDF rendering with pdfmake (section 2: payslips, tax certificates, reports). The
 * Roboto font is embedded from pdfmake's bundled virtual file system, so rendering never fetches
 * anything over the network.
 */
@Injectable()
export class PdfService {
  private static printerInstance: PdfPrinter | undefined;

  private static fonts(): TFontDictionary {
    const font = (file: string): Buffer => {
      const data = vfs[file];
      if (!data) throw new Error(`pdfmake font ${file} is missing`);
      return Buffer.from(data, 'base64');
    };
    return {
      Roboto: {
        normal: font('Roboto-Regular.ttf'),
        bold: font('Roboto-Medium.ttf'),
        italics: font('Roboto-Italic.ttf'),
        bolditalics: font('Roboto-MediumItalic.ttf'),
      },
    };
  }

  private printer(): PdfPrinter {
    PdfService.printerInstance ??= new PdfPrinter(PdfService.fonts());
    return PdfService.printerInstance;
  }

  private document(definition: TDocumentDefinitions) {
    return this.printer().createPdfKitDocument({
      ...definition,
      defaultStyle: { font: 'Roboto', fontSize: 9, ...definition.defaultStyle },
    });
  }

  /** Renders the whole document into memory (payslips and certificates are a page or two). */
  render(definition: TDocumentDefinitions): Promise<Buffer> {
    const pdf = this.document(definition);
    const chunks: Buffer[] = [];
    return new Promise<Buffer>((resolve, reject) => {
      pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
      pdf.on('end', () => resolve(Buffer.concat(chunks)));
      pdf.on('error', reject);
      pdf.end();
    });
  }

  /** Streams the document as it is written (report exports). */
  stream(definition: TDocumentDefinitions): Readable {
    const out = new PassThrough();
    const pdf = this.document(definition);
    pdf.on('error', (err: Error) => out.destroy(err));
    pdf.pipe(out);
    pdf.end();
    return out;
  }
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

@Module({ providers: [PdfService], exports: [PdfService] })
export class PdfModule {}
