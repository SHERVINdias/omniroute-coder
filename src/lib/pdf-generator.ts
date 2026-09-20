import puppeteer from "puppeteer";
import { marked } from "marked";
import fs from "fs";
import path from "path";

export interface PdfGenerationResult {
  pdfUrl: string;
  fileName: string;
  title: string;
}

export async function generatePdfFromMarkdown(
  markdownContent: string,
  title: string = "Document",
): Promise<PdfGenerationResult> {
  const htmlBody = await marked.parse(markdownContent);

  const fullHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>${title}</title>
        <style>
          @page { margin: 20mm; size: A4; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            color: #1a202c;
            line-height: 1.6;
            padding: 0;
            margin: 0;
          }
          h1, h2, h3, h4 { color: #0f172a; margin-top: 1.5em; margin-bottom: 0.5em; font-weight: 700; }
          h1 { font-size: 22pt; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; }
          h2 { font-size: 16pt; border-bottom: 1px solid #cbd5e1; padding-bottom: 4px; }
          p { margin-bottom: 1em; font-size: 10.5pt; }
          table { width: 100%; border-collapse: collapse; margin: 1.5em 0; font-size: 10pt; }
          th, td { border: 1px solid #cbd5e1; padding: 8px 12px; text-align: left; }
          th { background-color: #f8fafc; font-weight: 600; }
          code { background: #f1f5f9; padding: 2px 4px; border-radius: 4px; font-family: monospace; }
          pre { background: #0f172a; color: #f8fafc; padding: 12px; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; }
          blockquote { border-left: 4px solid #d97706; margin: 1em 0; padding-left: 12px; color: #475569; }
          ul, ol { padding-left: 20px; margin-bottom: 1em; }
          li { margin-bottom: 4px; }
        </style>
      </head>
      <body>
        ${htmlBody}
      </body>
    </html>
  `;

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    /* "load" rather than "networkidle0": Puppeteer v25 narrowed setContent's
     * waitUntil to "load" | "domcontentloaded" and the old value no longer type
     * checks. "load" is the right one here anyway — it waits for images and
     * stylesheets referenced by the HTML, which is what the PDF needs. */
    await page.setContent(fullHtml, { waitUntil: "load" });

    const publicDir = path.join(process.cwd(), "public", "generated-pdfs");
    if (!fs.existsSync(publicDir)) {
      fs.mkdirSync(publicDir, { recursive: true });
    }

    const cleanTitle = title.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
    const fileName = `${cleanTitle || "document"}-${Date.now()}.pdf`;
    const filePath = path.join(publicDir, fileName);

    await page.pdf({
      path: filePath,
      format: "A4",
      printBackground: true,
      margin: { top: "20mm", bottom: "20mm", left: "15mm", right: "15mm" },
    });

    return {
      pdfUrl: `/generated-pdfs/${fileName}`,
      fileName,
      title,
    };
  } finally {
    await browser.close();
  }
}
