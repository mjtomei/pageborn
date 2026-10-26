// Small, original PDF fixtures with known geometric reading order. No network,
// third-party PDFs or user documents are needed for the regression suite.
import { deflateSync } from 'node:zlib';

export function scannedPdfFixture(width, height, pixels, { bilevel = false, textLayer = [], jpeg2000 = false } = {}) {
  const compressed = jpeg2000 ? pixels : deflateSync(pixels);
  const stream = `q 600 0 0 800 0 0 cm /Scan Do Q\n` + textLayer.map(({ text, x, y, size = 24 }) =>
    `BT 3 Tr /F1 ${size} Tf 1 0 0 1 ${x} ${800 - y} Tm (${text.replace(/[\\()]/g, '\\$&')}) Tj ET`).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /XObject << /Scan 5 0 R >> /Font << /F1 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ${jpeg2000 ? '/Filter /JPXDecode' : `/ColorSpace /${bilevel ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent ${bilevel ? 1 : 8} /Filter /FlateDecode`} /Length ${compressed.length} >>\nstream\n`), compressed, Buffer.from('\nendstream')]),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const parts = [Buffer.from('%PDF-1.7\n')]; const offsets = []; let length = parts[0].length;
  for (const [i, object] of objects.entries()) {
    offsets.push(length); const part = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.from(object), Buffer.from('\nendobj\n')]);
    parts.push(part); length += part.length;
  }
  parts.push(Buffer.from(`xref\n0 7\n0000000000 65535 f \n${offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(parts);
}

export function pdfFixture(kind = 'mixed') {
  const pages = []; let commands = [];
  const text = (value, x, y, size = 12) => commands.push(`BT /F1 ${size} Tf 1 0 0 1 ${x} ${800 - y} Tm (${value.replace(/[\\()]/g, '\\$&')}) Tj ET`);
  const paragraph = (name, x, y, wide = false, count = 4) => {
    for (let i = 0; i < count; i++) text(`${name}${i === 0 ? 'Start' : i} ${wide ? 'A full width paragraph crosses the center and keeps its text together.' : 'Read this column in order.'}`, x, y + i * 16, 11);
  };
  if (kind === 'mixed' || kind === 'magazine') {
    if (kind === 'magazine') {
      // A pale inner-paper rectangle plus an unpainted clipping path. Both
      // have recorded bounds but must not hold the two columns together.
      commands.push('q 0.992 0.992 0.984 rg 40 50 520 700 re f Q');
      commands.push('q 40 50 520 700 re W n Q');
    }
    text('Mixed columns and a full-width figure', 80, 35, 21);
    paragraph('Intro', 55, 75, true, 3);
    paragraph('LeftA', 55, 170); paragraph('LeftB', 55, 260);
    paragraph('RightA', 330, 170); paragraph('RightB', 330, 260);
    commands.push('2 w 55 340 490 90 re S'); text('FigureStart: full-width vector diagram', 120, 400, 16);
    commands.push('55 380 m 545 380 l S 155 340 m 155 430 l S 435 340 m 435 430 l S');
    paragraph('LeftC', 55, 500); paragraph('RightC', 330, 500);
    paragraph('Conclusion', 55, 640, true, 4);
    pages.push(commands.join('\n')); commands = [];
    text('Single-column page after the mixed layout', 60, 40, 20);
    paragraph('LongParagraph', 55, 85, true, 31);
    paragraph('LastParagraph', 55, 660, true, 4);
    pages.push(commands.join('\n'));
  } else if (kind === 'equation') {
    paragraph('BeforeEquation', 55, 90, true, 7);
    text('x^2 = y^2', 55, 330, 18);
    paragraph('AfterEquation', 55, 440, true, 9);
    pages.push(commands.join('\n'));
  } else if (kind === 'annotations') {
    text('I', 280, 85, 16);
    paragraph('OpeningBody', 55, 140, true, 8);
    text('A sentence with reference', 55, 285, 11); text('1', 179, 281, 7);
    text(' continues onto the next PDF page', 184, 285, 11);
    text('1. FirstNote: a smaller explanation deferred until the section ends.', 55, 690, 8);
    text('633', 280, 742, 11);
    pages.push(commands.join('\n')); commands = [];
    paragraph('ContinuedBody', 55, 85, true, 5);
    commands.push('2 w 100 445 400 130 re S 100 510 m 500 510 l S');
    text('DiagramContent', 130, 275, 14);
    text('Figure 1: CaptionText explains the diagram after this section.', 100, 375, 10);
    text('II', 280, 435, 16);
    paragraph('SecondSection', 55, 490, true, 7);
    text('The next reference', 55, 615, 11); text('2', 146, 611, 7);
    text(' belongs to this second section.', 151, 615, 11);
    text('2. SecondNote: another explanation with an original page label.', 55, 690, 8);
    text('634', 280, 742, 11);
    pages.push(commands.join('\n')); commands = [];
    paragraph('FinalBody', 55, 85, true, 18);
    text('635', 280, 742, 11);
    pages.push(commands.join('\n'));
  } else if (kind === 'repeated-text') {
    for (let n = 0; n < 8; n++) {
      commands = [];
      text(n % 2 ? `JournalHeader ${100 + n}` : `ArticleHeader ${100 + n}`, 60, 45, 11);
      paragraph(`BodyPage${n}`, 55, 140, true, 4);
      text('A long paragraph ends with a short continuation and should remain readable', 55, 300, 11);
      text('or explanations.', 55, 316, 11);
      text(`FootnotePage${n}: An original note that remains part of this document.`, 55, 680, 9);
      text(`ArchiveDownload: 2026-09-${20 + n}`, 150, 749, 8);
      text('ArchiveTerms: use subject to terms.', 150, 762, 8);
      pages.push(commands.join('\n'));
    }
  } else if (kind === 'figure') {
    text('Tall figure remains one scrollable image', 60, 40, 20);
    commands.push('2 w 100 90 400 620 re S');
    for (let y = 120; y <= 680; y += 80) commands.push(`100 ${y} m 500 ${y} l S`);
    text('FigureTop', 180, 115, 18); text('FigureBottom', 180, 690, 18);
    pages.push(commands.join('\n'));
  } else if (kind === 'table') {
    text('Table columns must stay side by side', 65, 45, 18);
    for (const y of [100, 130, 300]) commands.push(`0.7 w 100 ${800 - y} m 500 ${800 - y} l S`);
    text('Label', 110, 120); text('Value', 370, 120);
    for (let row = 0; row < 8; row++) {
      text(`Row${row}Label`, 110, 155 + row * 18); text(`Row${row}Value`, 370, 155 + row * 18);
    }
    paragraph('AfterTable', 55, 370, true, 16);
    pages.push(commands.join('\n'));
  } else if (kind === 'margins') {
    text('A document with notes in both margins', 110, 40, 16);
    for (let y = 85; y <= 565; y += 16) text('MainBody: The paragraph stays readable across the full screen.', 120, y, 11);
    for (let i = 0; i < 4; i++) text(`LeftNote${i}`, 30, 100 + i * 12, 8);
    for (let i = 0; i < 3; i++) text(`RightNote${i}`, 490, 270 + i * 12, 8);
    text('BottomFootnote: This remains part of the reading text.', 120, 640, 9);
    pages.push(commands.join('\n'));
  } else if (kind === 'colors') {
    for (const [paper, ink] of [
      ['1 1 1', '0 0 0'], ['0 0 0', '1 1 1'], ['1 1 1', '1 1 0'],
      ['0 .4 0', '1 0 0'], ['.02 .04 .16', '.55 .7 .95'], ['.96 .93 .85', '.76 .73 .65'],
    ]) {
      commands = [`${paper} rg 0 0 600 800 re f`, `${ink} rg`];
      text(`ColorPage${pages.length + 1}`, 55, 70, 22);
      paragraph('ColoredText', 55, 130, true, 20);
      pages.push(commands.join('\n'));
    }
    commands = []; text('Mixed light and dark panels', 55, 70, 22);
    paragraph('LightPanel', 55, 130, true, 4);
    commands.push('.02 .04 .16 rg 50 290 500 280 re f .55 .7 .95 rg');
    paragraph('DarkPanel', 55, 275, true, 12);
    pages.push(commands.join('\n'));
  } else if (kind === 'long-book') {
    for (let n = 1; n <= 450; n++) {
      commands = []; text(`Original book page ${n}`, 60, 240, 16);
      paragraph(`Page${n}Body`, 55, 290, true, 4);
      pages.push(commands.join('\n'));
    }
  } else if (kind === 'blank') pages.push('');
  else throw new Error(`Unknown PDF fixture ${kind}`);
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (const stream of pages) {
    const page = objects.length + 1; const contents = page + 1; kids.push(`${page} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contents} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${kids.join(' ')}] >>`;
  let source = '%PDF-1.7\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(source)); source += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source);
}
