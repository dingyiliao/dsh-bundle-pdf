import { classicPdf } from './plain-pdf.ts'

/** Three independent pages plus deliberate shared/dependency fields; synthetic data only. */
export async function formPageBatchesFixture() {
  return classicPdf([
    '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R 7 0 R 8 0 R 9 0 R 12 0 R 13 0 R 14 0 R]'
      + ' /DA (/F1 12 Tf 0 g) /DR << /Font << /F1 15 0 R >> >> >> >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 /MediaBox [0 0 400 600] >>',
    '<< /Type /Page /Parent 2 0 R /Annots [6 0 R 10 0 R 12 0 R 13 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /Annots [7 0 R 11 0 R 14 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /Annots [8 0 R] >>',
    ...[3, 4, 5].map((page, index) => `<< /Type /Annot /Subtype /Widget /FT /Tx /T (page-${index + 1}) /F 4
       /P ${page} 0 R /Rect [30 500 230 524] >>`),
    '<< /FT /Tx /T (shared) /Kids [10 0 R 11 0 R] >>',
    ...[3, 4].map(page => `<< /Type /Annot /Subtype /Widget /Parent 9 0 R /F 4 /P ${page} 0 R /Rect [30 440 230 464] >>`),
    ...[['controller', 3, 380], ['alternative-1', 3, 320], ['alternative-2', 4, 320]].map(([name, page, y]) =>
      `<< /Type /Annot /Subtype /Widget /FT /Btn /T (${name}) /V /Off /AS /Off /F 4
        /P ${page} 0 R /Rect [30 ${y} 50 ${Number(y) + 20}] /AP << /N << /Off 16 0 R /Yes 17 0 R >> >> >>`),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /XObject /Subtype /Form /BBox [0 0 20 20] /Length 0 >>\nstream\nendstream',
    '<< /Type /XObject /Subtype /Form /BBox [0 0 20 20] /Length 14 >>\nstream\n0 0 20 20 re f\nendstream',
  ])
}
