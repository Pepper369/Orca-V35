import html2canvas from "html2canvas-pro";
import { jsPDF } from "jspdf";

const NAVY_BG = "#081320";

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureElement(el: HTMLElement): Promise<HTMLCanvasElement> {
  const cloneHost = document.createElement("div");
  cloneHost.style.position = "fixed";
  cloneHost.style.left = "-100000px";
  cloneHost.style.top = "0";
  cloneHost.style.width = `${Math.max(el.scrollWidth, 1440)}px`;
  cloneHost.style.background = NAVY_BG;
  cloneHost.style.padding = "0";
  cloneHost.style.zIndex = "-1";

  const clone = el.cloneNode(true) as HTMLElement;
  clone.classList.add("orca-export-mode");
  clone.style.width = `${Math.max(el.scrollWidth, 1440)}px`;
  clone.style.maxWidth = "none";
  clone.style.margin = "0";
  clone.style.transform = "none";
  cloneHost.appendChild(clone);
  document.body.appendChild(cloneHost);

  await wait(120);

  try {
    return await html2canvas(clone, {
      backgroundColor: NAVY_BG,
      scale: Math.max(3, window.devicePixelRatio || 2),
      useCORS: true,
      logging: false,
      windowWidth: clone.scrollWidth,
      windowHeight: clone.scrollHeight,
      foreignObjectRendering: true,
      imageTimeout: 15000,
      allowTaint: false,
      onclone: (doc) => {
        doc.body.classList.add("orca-export-root");
      },
    });
  } finally {
    document.body.removeChild(cloneHost);
  }
}

/** Export a DOM element to a downloadable PNG file. */
export async function exportToPNG(el: HTMLElement, fileName: string): Promise<void> {
  const canvas = await captureElement(el);
  const dataUrl = canvas.toDataURL("image/png", 1.0);
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = `${fileName}.png`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/** Export a DOM element to a multi-page A4 PDF (portrait). */
export async function exportToPDF(el: HTMLElement, fileName: string): Promise<void> {
  const canvas = await captureElement(el);
  const imgData = canvas.toDataURL("image/png", 1.0);

  const pdf = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: "a4",
    compress: true,
  });

  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 6;
  const imgWidth = pageWidth - margin * 2;
  const imgHeight = (canvas.height * imgWidth) / canvas.width;

  let heightLeft = imgHeight;
  let position = margin;

  const paintPage = () => {
    pdf.setFillColor(8, 19, 32);
    pdf.rect(0, 0, pageWidth, pageHeight, "F");
    pdf.setDrawColor(212, 175, 55);
    pdf.setLineWidth(0.4);
    pdf.roundedRect(3, 3, pageWidth - 6, pageHeight - 6, 3, 3, "S");
  };

  paintPage();
  pdf.addImage(imgData, "PNG", margin, position, imgWidth, imgHeight, undefined, "FAST");
  heightLeft -= pageHeight - margin * 2;

  while (heightLeft > 0) {
    position -= pageHeight - margin * 2;
    pdf.addPage();
    paintPage();
    pdf.addImage(imgData, "PNG", margin, position, imgWidth, imgHeight, undefined, "FAST");
    heightLeft -= pageHeight - margin * 2;
  }

  pdf.save(`${fileName}.pdf`);
}
