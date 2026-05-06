declare module "mailparser" {
  export interface ParsedAttachment {
    filename?: string;
    contentType?: string;
    content?: Buffer | Uint8Array;
  }
  export interface ParsedMail {
    from?: { text?: string };
    to?: { text?: string };
    subject?: string;
    date?: Date | string;
    text?: string;
    html?: string | false;
    attachments?: ParsedAttachment[];
  }
  export function simpleParser(input: Buffer | string | NodeJS.ReadableStream): Promise<ParsedMail>;
}
