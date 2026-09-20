import * as pdfjsLib from "pdfjs-dist";

// Set up worker source for browser environment
pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

export interface ExtractedPage {
  pageNumber: number;
  text: string;
  base64Image: string;
}

export async function processPdfForOmniRoute(
  file: File,
  maxScale: number = 1.5,
): Promise<ExtractedPage[]> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages: ExtractedPage[] = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);

    // Extract raw text
    const textContent = await page.getTextContent();
    const text = textContent.items.map((item: any) => item.str).join(" ");

    // Render page to high-DPI canvas
    const viewport = page.getViewport({ scale: maxScale });
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    if (context) {
      canvas.height = viewport.height;
      canvas.width = viewport.width;

      await page.render({
        canvasContext: context,
        viewport: viewport,
      }).promise;

      const base64Image = canvas.toDataURL("image/png");
      pages.push({ pageNumber: pageNum, text, base64Image });
    }
  }

  return pages;
}
