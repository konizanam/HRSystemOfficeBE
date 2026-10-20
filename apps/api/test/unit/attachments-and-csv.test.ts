import { describe, expect, it } from 'vitest';
import {
  checkFile,
  extensionOf,
  mimeTypeForExtension,
  normaliseMimeType,
  safeFileName,
  sniffMimeType,
} from '../../src/modules/attachments/file-sniffer';
import { NoopVirusScanner, parseClamdReply } from '../../src/modules/attachments/virus-scanner';
import { parseCsv } from '../../src/modules/leave/csv';

const PDF = Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj\n', 'latin1');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const DOCX = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from('....[Content_Types].xml....word/document.xml....', 'latin1'),
]);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('notes.txt', 'latin1')]);
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('magic-byte sniffer (section 10.4)', () => {
  it('recognises the accepted types by their leading bytes', () => {
    expect(sniffMimeType(PDF)).toBe('application/pdf');
    expect(sniffMimeType(PNG)).toBe('image/png');
    expect(sniffMimeType(JPEG)).toBe('image/jpeg');
    expect(sniffMimeType(DOCX)).toBe(DOCX_TYPE);
    expect(sniffMimeType(ZIP)).toBeNull();
    expect(sniffMimeType(Buffer.from('MZ\x90\x00 executable'))).toBeNull();
    expect(sniffMimeType(Buffer.alloc(0))).toBeNull();
  });

  it('checks extension, declared type and content together', () => {
    expect(checkFile('note.pdf', 'application/pdf', PDF)).toEqual({ ok: true, mimeType: 'application/pdf' });
    expect(checkFile('photo.JPG', 'image/jpg', JPEG)).toEqual({ ok: true, mimeType: 'image/jpeg' });
    expect(checkFile('letter.docx', 'application/octet-stream', DOCX)).toEqual({
      ok: true,
      mimeType: DOCX_TYPE,
    });
    // A renamed executable: the bytes do not match the declared PDF type.
    expect(checkFile('virus.pdf', 'application/pdf', Buffer.from('MZ\x90\x00'))).toMatchObject({ ok: false });
    // A PNG declared as a PDF.
    expect(checkFile('scan.pdf', 'image/png', PNG)).toMatchObject({
      ok: false,
      reason: 'The file type does not match the file name',
    });
    expect(checkFile('script.exe', 'application/x-msdownload', PDF)).toMatchObject({ ok: false });
    expect(checkFile('archive.docx', DOCX_TYPE, ZIP)).toMatchObject({ ok: false });
  });

  it('normalises names and types', () => {
    expect(extensionOf('C:\\fake\\path\\Report.Final.PDF')).toBe('pdf');
    expect(extensionOf('.bashrc')).toBe('');
    expect(mimeTypeForExtension('jpeg')).toBe('image/jpeg');
    expect(mimeTypeForExtension('gif')).toBeNull();
    expect(normaliseMimeType('Image/PJPEG; charset=binary')).toBe('image/jpeg');
    expect(normaliseMimeType('application/x-pdf')).toBe('application/pdf');
    expect(normaliseMimeType(undefined)).toBe('');
    expect(safeFileName('../../etc/pass"wd<1>.pdf')).toBe('pass_wd_1_.pdf');
    expect(safeFileName('   ')).toBe('file');
  });
});

describe('virus scanner hook', () => {
  it('reads clamd replies', () => {
    expect(parseClamdReply('stream: OK')).toEqual({ clean: true });
    expect(parseClamdReply('stream: Eicar-Test-Signature FOUND')).toEqual({
      clean: false,
      signature: 'Eicar-Test-Signature',
    });
    expect(parseClamdReply('INSTREAM size limit exceeded. ERROR')).toBeNull();
  });

  it('defaults to a scanner that accepts everything', async () => {
    const scanner = new NoopVirusScanner();
    expect(scanner.name).toBe('none');
    expect(await scanner.scan()).toEqual({ clean: true });
  });
});

describe('CSV reader', () => {
  it('reads quoted fields, escaped quotes and CRLF lines, skipping blank lines', () => {
    expect(parseCsv('\uFEFFa,b,c\r\n1,"x, y","say ""hi"""\r\n\r\n2,,last\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', 'x, y', 'say "hi"'],
      ['2', '', 'last'],
    ]);
    expect(parseCsv('a,b\n"multi\nline",2')).toEqual([
      ['a', 'b'],
      ['multi\nline', '2'],
    ]);
    expect(parseCsv('')).toEqual([]);
  });
});
