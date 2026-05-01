/**
 * Task #910 — Document ingestion pipeline.
 *
 * Single entry: `ingestDocument({ source, file, uploader, context })`.
 *
 * Lifecycle:
 *   1. Hash bytes (SHA-256). If a document with the same hash already
 *      exists for this org, return it as-is — no re-parsing, no new row.
 *   2. Persist raw bytes via `documentStorage` (Replit Object Storage,
 *      Postgres fallback in tests).
 *   3. Insert a `documents` row in status `parsing`.
 *   4. Extract text page-by-page based on mime type:
 *        - PDF → native `pdf-parse`; if extracted text is empty/scarce,
 *          fall back to OCR (Azure Document Intelligence; gracefully
 *          degrades to "ocr_unavailable" failure when the secret is
 *          missing — admin can retry once the secret is configured).
 *        - Images → OCR.
 *        - XLSX/XLS/CSV → existing `xlsx` path; one page per sheet,
 *          each row preserved in `tableRows`.
 *        - EML/MSG → header + body becomes a single page; nested
 *          attachments are recursively re-ingested.
 *        - Plain text → one page.
 *   5. Persist pages.
 *   6. Run `classifyDocument` against the first page text + filename.
 *   7. Mark `parsed` (or `failed` with a structured reason).
 *
 * The whole thing is best-effort by design — a single bad attachment in a
 * forwarded email shouldn't fail the entire batch. Errors land on the doc
 * row as `status=failed, errorReason=...` so the admin queue can surface
 * and retry them. The needs-attention queue from #97 reads these directly.
 */
import { createHash } from "node:crypto";
import { storage } from "../storage";
import {
  buildStorageKey,
  putDocumentBytes,
  getDocumentBytes,
} from "./documentStorage";
import { classifyDocument, type ClassificationResult } from "./documentClassifier";
import {
  type Document,
  type InsertDocumentPage,
  type DocumentSourceChannel,
} from "@shared/schema";

export interface IngestFileInput {
  filename: string;
  mimeType: string;
  bytes: Buffer;
}

export interface IngestUploader {
  id: string;
  organizationId: string;
}

export interface IngestUploadContext {
  // Free-form: { entityType: "company"|"contact"|"prospect"|..., entityId, page }
  // The agent context section uses `companyId` for visibility filtering.
  companyId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  pagePath?: string | null;
  [k: string]: unknown;
}

export interface IngestEmailMeta {
  fromEmail: string | null;
  subject: string | null;
}

export interface IngestDocumentArgs {
  source: DocumentSourceChannel;
  file: IngestFileInput;
  uploader: IngestUploader;
  context?: IngestUploadContext;
  email?: IngestEmailMeta;
  /** Test override — inject a stubbed OpenAI client to skip the model call. */
  openaiOverride?: Parameters<typeof classifyDocument>[1];
}

export interface IngestDocumentResult {
  document: Document;
  deduped: boolean;
  classification: ClassificationResult | null;
  pagesWritten: number;
  failed: boolean;
  errorReason: string | null;
}

// ─── Page extraction ──────────────────────────────────────────────────────

/** Cell of a parsed spreadsheet row — preserved verbatim for downstream tools. */
type TableCellValue = string | number | boolean | null;
type TableRow = Record<string, TableCellValue>;

/**
 * Per-page provenance captured from Azure Doc Intelligence. We persist line
 * polygons (and word polygons when present) so future field-level extraction
 * passes can map an answer span back to a region of the original page.
 */
interface OcrLineGeometry {
  text: string;
  /** Azure returns 8-number polygons (x1,y1,...,x4,y4) in inches by default. */
  polygon: number[];
}
interface OcrWordGeometry {
  text: string;
  polygon: number[];
  confidence: number;
}
interface OcrPageProvenance {
  unit: string | null;          // "inch" | "pixel" | null
  width: number | null;
  height: number | null;
  lines: OcrLineGeometry[];
  words: OcrWordGeometry[];
}

interface ExtractedPage {
  pageNumber: number;
  text: string | null;
  tableRows?: TableRow[] | null;
  bbox?: OcrPageProvenance | null;
}

interface ExtractionResult {
  pages: ExtractedPage[];
  ocrUsed: boolean;
  /** Recursively-discovered child files (EML attachments). */
  children: IngestFileInput[];
}

// ─── Typed shims for dynamically-imported third-party libs ────────────────

interface PdfParsePage { pageNumber?: number; text?: string }
interface PdfParseResult { pages?: PdfParsePage[]; text?: string }
interface PdfParseInstance { getText(): Promise<PdfParseResult> }
interface PdfParseCtor { new (opts: { data: Uint8Array }): PdfParseInstance }
interface PdfParseModule { PDFParse?: PdfParseCtor; default?: PdfParseCtor | PdfParseModule }

interface XlsxWorkbook {
  SheetNames: string[];
  Sheets: Record<string, unknown>;
}
interface XlsxModule {
  read(data: Buffer, opts: { type: "buffer" }): XlsxWorkbook;
  utils: {
    sheet_to_json(sheet: unknown, opts: { defval: string; raw: boolean }): TableRow[];
  };
}

interface MailparserAttachment {
  filename?: string;
  contentType?: string;
  content?: Buffer | Uint8Array | string;
}
interface MailparserAddress { text?: string }
interface MailparserParsed {
  from?: MailparserAddress;
  to?: MailparserAddress;
  subject?: string;
  date?: Date | string;
  text?: string;
  html?: string;
  attachments?: MailparserAttachment[];
}
interface MailparserModule {
  simpleParser(input: Buffer): Promise<MailparserParsed>;
}

const PDF_NATIVE_TEXT_MIN_CHARS_PER_PAGE = 25;

async function extractPdf(bytes: Buffer): Promise<ExtractionResult> {
  // Native first.
  let nativePages: ExtractedPage[] = [];
  try {
    const pdfMod = (await import("pdf-parse")) as unknown as PdfParseModule;
    const PDFParse: PdfParseCtor | undefined =
      pdfMod.PDFParse ??
      (typeof pdfMod.default === "function" ? (pdfMod.default as PdfParseCtor) : undefined) ??
      (pdfMod.default && typeof pdfMod.default === "object" && "PDFParse" in pdfMod.default
        ? (pdfMod.default as PdfParseModule).PDFParse
        : undefined);
    if (!PDFParse) throw new Error("pdf-parse: PDFParse constructor not found");
    const parser = new PDFParse({ data: new Uint8Array(bytes) });
    const result = await parser.getText();
    // pdf-parse v2: { pages?: Array<{ pageNumber, text }>, text }
    if (result?.pages && Array.isArray(result.pages) && result.pages.length > 0) {
      nativePages = result.pages.map((p, i) => ({
        pageNumber: typeof p.pageNumber === "number" ? p.pageNumber : i + 1,
        text: typeof p.text === "string" ? p.text : "",
      }));
    } else if (typeof result?.text === "string" && result.text.trim().length > 0) {
      nativePages = [{ pageNumber: 1, text: result.text }];
    }
  } catch (err) {
    console.warn("[documentIngestion] pdf-parse failed:", err);
  }

  const totalChars = nativePages.reduce((acc, p) => acc + (p.text?.length ?? 0), 0);
  const avgPerPage = nativePages.length ? totalChars / nativePages.length : 0;

  if (nativePages.length > 0 && avgPerPage >= PDF_NATIVE_TEXT_MIN_CHARS_PER_PAGE) {
    return { pages: nativePages, ocrUsed: false, children: [] };
  }

  // Scanned PDF — try OCR fallback. If no vendor configured, mark all pages
  // empty so the doc lands as failed/ocr_unavailable.
  const ocr = await runOcrIfAvailable(bytes, "application/pdf");
  if (ocr) {
    return { pages: ocr.pages, ocrUsed: true, children: [] };
  }
  if (nativePages.length > 0) {
    // Native returned something, just very little. Keep it.
    return { pages: nativePages, ocrUsed: false, children: [] };
  }
  // Nothing salvageable. Throw so the doc lands failed with a clear reason.
  throw new Error("ocr_unavailable");
}

async function extractImage(bytes: Buffer, mimeType: string): Promise<ExtractionResult> {
  const ocr = await runOcrIfAvailable(bytes, mimeType);
  if (!ocr) throw new Error("ocr_unavailable");
  return { pages: ocr.pages, ocrUsed: true, children: [] };
}

async function extractXlsxOrCsv(bytes: Buffer, mimeType: string): Promise<ExtractionResult> {
  const xlsxMod = (await import("xlsx")) as unknown as XlsxModule;
  const wb = xlsxMod.read(bytes, { type: "buffer" });
  const pages: ExtractedPage[] = [];
  wb.SheetNames.forEach((name: string, idx: number) => {
    const sheet = wb.Sheets[name];
    const rows = xlsxMod.utils.sheet_to_json(sheet, { defval: "", raw: false });
    const text = rows.length
      ? `Sheet: ${name}\n` +
        rows.slice(0, 200).map((r) => Object.entries(r).map(([k, v]) => `${k}=${String(v ?? "").slice(0, 80)}`).join(" | ")).join("\n")
      : `Sheet: ${name} (empty)`;
    pages.push({
      pageNumber: idx + 1,
      text,
      tableRows: rows.slice(0, 1000),
    });
  });
  if (mimeType === "text/csv" && pages.length === 0) {
    const text = bytes.toString("utf-8");
    pages.push({ pageNumber: 1, text });
  }
  return { pages, ocrUsed: false, children: [] };
}

async function extractEml(bytes: Buffer): Promise<ExtractionResult> {
  let parsed: MailparserParsed | null = null;
  try {
    const mp = (await import("mailparser")) as unknown as MailparserModule;
    parsed = await mp.simpleParser(bytes);
  } catch (err) {
    console.warn("[documentIngestion] mailparser failed:", err);
    return { pages: [{ pageNumber: 1, text: bytes.toString("utf-8").slice(0, 8000) }], ocrUsed: false, children: [] };
  }
  const headers: string[] = [];
  if (parsed.from?.text) headers.push(`From: ${parsed.from.text}`);
  if (parsed.to?.text) headers.push(`To: ${parsed.to.text}`);
  if (parsed.subject) headers.push(`Subject: ${parsed.subject}`);
  if (parsed.date) headers.push(`Date: ${new Date(parsed.date).toISOString()}`);
  const body = (parsed.text ?? parsed.html ?? "").toString().slice(0, 32000);
  const pageText = `${headers.join("\n")}\n\n${body}`.trim();

  const children: IngestFileInput[] = [];
  for (const att of parsed.attachments ?? []) {
    if (!att?.content) continue;
    const buf: Buffer = Buffer.isBuffer(att.content)
      ? att.content
      : Buffer.from(att.content as Uint8Array | string);
    children.push({
      filename: att.filename || "attachment",
      mimeType: att.contentType || "application/octet-stream",
      bytes: buf,
    });
  }
  return { pages: [{ pageNumber: 1, text: pageText }], ocrUsed: false, children };
}

async function extractPlainText(bytes: Buffer): Promise<ExtractionResult> {
  const text = bytes.toString("utf-8");
  return { pages: [{ pageNumber: 1, text }], ocrUsed: false, children: [] };
}

interface OcrPagesResult {
  pages: ExtractedPage[];
}

// Minimal subset of the Azure Doc Intelligence REST response we touch.
// Anything we don't read stays absent from the type — this is a contract
// surface, not an exhaustive mirror.
interface AzureOcrLine { content?: string; polygon?: number[] }
interface AzureOcrWord { content?: string; polygon?: number[]; confidence?: number }
interface AzureOcrPage {
  pageNumber?: number;
  unit?: string;
  width?: number;
  height?: number;
  lines?: AzureOcrLine[];
  words?: AzureOcrWord[];
}
interface AzureAnalyzeResponse {
  status?: "running" | "succeeded" | "failed" | string;
  analyzeResult?: { pages?: AzureOcrPage[] };
}

/**
 * OCR vendor wiring. Defaults to Azure Document Intelligence when the env
 * `AZURE_DOC_INTEL_ENDPOINT` and `AZURE_DOC_INTEL_KEY` are set; returns
 * `null` when no vendor is configured (admin retry surfaces this).
 *
 * The integration is intentionally thin: a single REST call to the
 * `prebuilt-read` model. We don't want to pull in the full Azure SDK for a
 * Phase 2 slice 1 — when we wire field-level extraction in slice 2 we'll
 * upgrade to `prebuilt-document`.
 *
 * Provenance: each returned page carries `bbox` with the page's unit /
 * width / height plus per-line and per-word polygons. This satisfies the
 * doc foundation requirement that scanned docs preserve enough geometry
 * for downstream slice-2 field extraction to highlight source regions.
 */
async function runOcrIfAvailable(bytes: Buffer, contentType: string): Promise<OcrPagesResult | null> {
  const endpoint = process.env.AZURE_DOC_INTEL_ENDPOINT?.replace(/\/+$/, "");
  const key = process.env.AZURE_DOC_INTEL_KEY;
  if (!endpoint || !key) return null;
  try {
    const submit = await fetch(`${endpoint}/documentintelligence/documentModels/prebuilt-read:analyze?api-version=2024-11-30`, {
      method: "POST",
      headers: { "Content-Type": contentType, "Ocp-Apim-Subscription-Key": key },
      body: bytes,
    });
    if (!submit.ok || submit.status !== 202) {
      console.warn("[documentIngestion] OCR submit failed:", submit.status, await submit.text().catch(() => ""));
      return null;
    }
    const opLoc = submit.headers.get("operation-location");
    if (!opLoc) return null;
    // Poll up to 30s.
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const poll = await fetch(opLoc, { headers: { "Ocp-Apim-Subscription-Key": key } });
      if (!poll.ok) continue;
      const json = (await poll.json()) as AzureAnalyzeResponse;
      if (json?.status === "succeeded") {
        const pages = json.analyzeResult?.pages ?? [];
        return {
          pages: pages.map((p, i): ExtractedPage => {
            const lines = p.lines ?? [];
            const words = p.words ?? [];
            const text = lines.map((l) => l?.content ?? "").join("\n");
            const bbox: OcrPageProvenance = {
              unit: p.unit ?? null,
              width: typeof p.width === "number" ? p.width : null,
              height: typeof p.height === "number" ? p.height : null,
              lines: lines
                .filter((l): l is AzureOcrLine & { content: string; polygon: number[] } =>
                  typeof l.content === "string" && Array.isArray(l.polygon))
                .map((l) => ({ text: l.content, polygon: l.polygon })),
              words: words
                .filter((w): w is AzureOcrWord & { content: string; polygon: number[]; confidence: number } =>
                  typeof w.content === "string" && Array.isArray(w.polygon) && typeof w.confidence === "number")
                .map((w) => ({ text: w.content, polygon: w.polygon, confidence: w.confidence })),
            };
            return {
              pageNumber: typeof p.pageNumber === "number" ? p.pageNumber : i + 1,
              text,
              bbox,
            };
          }),
        };
      }
      if (json?.status === "failed") return null;
    }
    return null;
  } catch (err) {
    console.warn("[documentIngestion] OCR call threw:", err);
    return null;
  }
}

// ─── Mime routing ─────────────────────────────────────────────────────────
function mimeIsImage(mime: string): boolean { return mime.toLowerCase().startsWith("image/"); }
function mimeIsXlsx(mime: string, filename: string): boolean {
  const m = mime.toLowerCase();
  return (
    m === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    m === "application/vnd.ms-excel" ||
    /\.(xlsx|xls)$/i.test(filename)
  );
}
function mimeIsCsv(mime: string, filename: string): boolean {
  return mime.toLowerCase() === "text/csv" || /\.csv$/i.test(filename);
}
function mimeIsEml(mime: string, filename: string): boolean {
  // NOTE: we deliberately exclude `.msg` here. Outlook MSG is a CFBF/OLE
  // compound binary, NOT RFC822, and `mailparser.simpleParser` cannot
  // decode it (it would silently dump garbled bytes as the body). MSG
  // files take the "unsupported" branch in `extractByMime` so they land
  // as `failed` with a clear reason — admin retry won't help, and slice-2
  // can introduce a real MSG parser (e.g. @kenjiuno/msgreader) without
  // any silent regressions in the meantime.
  return mime.toLowerCase() === "message/rfc822" || /\.eml$/i.test(filename);
}
function mimeIsOutlookMsg(mime: string, filename: string): boolean {
  const m = mime.toLowerCase();
  return m === "application/vnd.ms-outlook" || /\.msg$/i.test(filename);
}
function mimeIsPdf(mime: string, filename: string): boolean {
  return mime.toLowerCase() === "application/pdf" || /\.pdf$/i.test(filename);
}
function mimeIsPlainText(mime: string, filename: string): boolean {
  return mime.toLowerCase() === "text/plain" || /\.txt$/i.test(filename);
}

async function extractByMime(file: IngestFileInput): Promise<ExtractionResult> {
  if (mimeIsPdf(file.mimeType, file.filename)) return extractPdf(file.bytes);
  if (mimeIsXlsx(file.mimeType, file.filename) || mimeIsCsv(file.mimeType, file.filename)) {
    return extractXlsxOrCsv(file.bytes, file.mimeType);
  }
  if (mimeIsEml(file.mimeType, file.filename)) return extractEml(file.bytes);
  if (mimeIsOutlookMsg(file.mimeType, file.filename)) {
    // Hard fail with an explicit reason rather than silently mis-parsing.
    throw new Error("outlook_msg_unsupported");
  }
  if (mimeIsImage(file.mimeType)) return extractImage(file.bytes, file.mimeType);
  if (mimeIsPlainText(file.mimeType, file.filename)) return extractPlainText(file.bytes);
  // Unknown binary — best-effort treat as plain text. Worst case: 0 chars.
  return extractPlainText(file.bytes);
}

// ─── Public entry point ───────────────────────────────────────────────────

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function ingestDocument(args: IngestDocumentArgs): Promise<IngestDocumentResult> {
  const { source, file, uploader, context, email } = args;
  const sha256 = sha256Hex(file.bytes);

  // 1. Dedup
  const existing = await storage.getDocumentBySha256(uploader.organizationId, sha256);
  if (existing) {
    return {
      document: existing,
      deduped: true,
      classification: null,
      pagesWritten: 0,
      failed: existing.status === "failed",
      errorReason: existing.errorReason,
    };
  }

  // 2. Persist bytes — HARD requirement. If we can't durably store the
  // raw file we record a `failed` row so the admin queue surfaces the
  // problem, but we never proceed to extraction/classification (those
  // would produce a "parsed" row with no retrievable bytes, which would
  // silently violate the find_documents contract).
  const key = buildStorageKey(uploader.organizationId, sha256, file.mimeType, file.filename);
  let storageUrl: string | null = null;
  let storagePutError: string | null = null;
  try {
    const put = await putDocumentBytes(key, file.bytes, file.mimeType);
    storageUrl = put.url;
  } catch (err) {
    storagePutError = err instanceof Error ? err.message : String(err);
    console.error("[documentIngestion] storage put failed:", storagePutError);
  }

  // 3. Insert documents row — start as `failed` if storage didn't take,
  // otherwise `parsing`.
  const initialStatus: "parsing" | "failed" = storagePutError ? "failed" : "parsing";
  const initialError: string | null = storagePutError
    ? `Storage write failed: ${storagePutError}`
    : null;
  const created = await storage.createDocument({
    organizationId: uploader.organizationId,
    uploaderId: uploader.id,
    filename: file.filename,
    mimeType: file.mimeType,
    byteSize: file.bytes.byteLength,
    sha256,
    sourceChannel: source,
    storageKey: key,
    storageUrl,
    uploadContext: (context ?? null) as IngestUploadContext | null,
    classLabel: "unknown",
    classConfidence: null,
    classMethod: null,
    status: initialStatus,
    errorReason: initialError,
    pageCount: null,
    ocrUsed: false,
    forwardedFromEmail: email?.fromEmail ?? null,
    forwardedSubject: email?.subject ?? null,
  });

  // If the raw bytes never landed, stop here — extraction against bytes
  // we don't have is meaningless and the admin retry path is the cure.
  if (storagePutError) {
    return {
      document: created,
      deduped: false,
      classification: null,
      pagesWritten: 0,
      failed: true,
      errorReason: initialError,
    };
  }

  // 4. Extract pages
  let pages: ExtractedPage[] = [];
  let ocrUsed = false;
  let children: IngestFileInput[] = [];
  let extractError: string | null = null;
  try {
    const ext = await extractByMime(file);
    pages = ext.pages;
    ocrUsed = ext.ocrUsed;
    children = ext.children;
  } catch (err) {
    extractError = err instanceof Error ? err.message : String(err);
  }

  // 5. Write pages
  const pageRows: InsertDocumentPage[] = pages.map((p) => ({
    documentId: created.id,
    pageNumber: p.pageNumber,
    text: p.text ?? null,
    tableRows: (p.tableRows ?? null) as TableRow[] | null,
    bbox: (p.bbox ?? null) as OcrPageProvenance | null,
  }));
  await storage.replaceDocumentPages(created.id, pageRows);

  // 6. Classify (deterministic + model fallback)
  const firstPageText = pages.find((p) => (p.text ?? "").trim().length > 0)?.text ?? "";
  let classification: ClassificationResult | null = null;
  try {
    classification = await classifyDocument(
      {
        filename: file.filename,
        mimeType: file.mimeType,
        firstPageText,
        emailSubject: email?.subject ?? null,
      },
      args.openaiOverride,
    );
    await storage.updateDocumentClass(
      created.id,
      uploader.organizationId,
      classification.label,
      classification.confidence,
      classification.method,
    );
  } catch (err) {
    console.warn("[documentIngestion] classification failed:", err);
  }

  // 7. Mark final status
  let failed = false;
  let errorReason: string | null = null;
  if (extractError) {
    failed = true;
    if (extractError === "ocr_unavailable") {
      errorReason = "OCR vendor not configured (set AZURE_DOC_INTEL_ENDPOINT/KEY) — image/scanned PDF cannot be parsed.";
    } else if (extractError === "outlook_msg_unsupported") {
      errorReason = "Outlook .msg format is not supported in this slice — please forward the email as RFC822 (.eml) or paste the body.";
    } else {
      errorReason = `Extraction failed: ${extractError}`;
    }
  } else if (pageRows.length === 0) {
    failed = true;
    errorReason = "No pages extracted";
  }
  await storage.updateDocumentStatus(
    created.id,
    uploader.organizationId,
    failed ? "failed" : "parsed",
    errorReason,
    pageRows.length || null,
    ocrUsed,
  );

  // 8. Recurse into EML children — best-effort, don't fail the parent.
  for (const child of children) {
    try {
      await ingestDocument({
        source,
        file: child,
        uploader,
        context: { ...(context ?? {}), parentDocumentId: created.id, fromEml: true },
        email: email ?? undefined,
        openaiOverride: args.openaiOverride,
      });
    } catch (err) {
      console.warn("[documentIngestion] EML child ingest failed:", err);
    }
  }

  const final = await storage.getDocument(created.id);
  return {
    document: final ?? created,
    deduped: false,
    classification,
    pagesWritten: pageRows.length,
    failed,
    errorReason,
  };
}

/**
 * Admin retry — re-runs extraction + classification against the existing
 * stored bytes. Status flips back to `parsing` for the duration.
 */
export async function retryDocument(documentId: string, organizationId: string): Promise<IngestDocumentResult | null> {
  const doc = await storage.getDocumentInOrg(documentId, organizationId);
  if (!doc) return null;
  const bytes = await getDocumentBytes(doc.storageKey);
  if (!bytes) {
    await storage.updateDocumentStatus(doc.id, organizationId, "failed", "Stored bytes missing", doc.pageCount, doc.ocrUsed);
    return null;
  }
  await storage.updateDocumentStatus(doc.id, organizationId, "parsing", null, null, false);
  // Reuse the public pipeline mid-flow: extract, write pages, classify, mark.
  let pages: ExtractedPage[] = [];
  let ocrUsed = false;
  let extractError: string | null = null;
  try {
    const ext = await extractByMime({ filename: doc.filename, mimeType: doc.mimeType, bytes: bytes.bytes });
    pages = ext.pages;
    ocrUsed = ext.ocrUsed;
  } catch (err) {
    extractError = err instanceof Error ? err.message : String(err);
  }
  const pageRows: InsertDocumentPage[] = pages.map((p) => ({
    documentId: doc.id,
    pageNumber: p.pageNumber,
    text: p.text ?? null,
    tableRows: (p.tableRows ?? null) as TableRow[] | null,
    bbox: (p.bbox ?? null) as OcrPageProvenance | null,
  }));
  await storage.replaceDocumentPages(doc.id, pageRows);
  const firstPageText = pages.find((p) => (p.text ?? "").trim().length > 0)?.text ?? "";
  let classification: ClassificationResult | null = null;
  try {
    classification = await classifyDocument({
      filename: doc.filename,
      mimeType: doc.mimeType,
      firstPageText,
      emailSubject: doc.forwardedSubject,
    });
    await storage.updateDocumentClass(doc.id, organizationId, classification.label, classification.confidence, classification.method);
  } catch (err) {
    console.warn("[documentIngestion] retry classification failed:", err);
  }
  let failed = false;
  let errorReason: string | null = null;
  if (extractError) {
    failed = true;
    if (extractError === "ocr_unavailable") {
      errorReason = "OCR vendor not configured — image/scanned PDF cannot be parsed.";
    } else if (extractError === "outlook_msg_unsupported") {
      errorReason = "Outlook .msg format is not supported in this slice — please forward as RFC822 (.eml).";
    } else {
      errorReason = `Extraction failed: ${extractError}`;
    }
  } else if (pageRows.length === 0) {
    failed = true;
    errorReason = "No pages extracted";
  }
  await storage.updateDocumentStatus(doc.id, organizationId, failed ? "failed" : "parsed", errorReason, pageRows.length || null, ocrUsed);
  const final = await storage.getDocument(doc.id);
  return {
    document: final ?? doc,
    deduped: false,
    classification,
    pagesWritten: pageRows.length,
    failed,
    errorReason,
  };
}
