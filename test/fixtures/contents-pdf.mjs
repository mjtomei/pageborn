// Original, small PDF with named/nested bookmarks and readable section targets.
export function contentsPdf({ outline = true } = {}) {
  const objects = ['', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (let n = 1; n <= 4; n++) {
    const id = objects.length + 1; kids.push(id);
    const text = (value, y, size = 12) => `BT /F1 ${size} Tf 1 0 0 1 55 ${800-y} Tm (${value}) Tj ET`;
    const commands = [text(n === 1 ? 'Chapter One' : n === 4 ? 'Chapter Two' : `Body page ${n}`, 70, 22)];
    for (let row = 0; row < 27; row++) commands.push(text(n === 2 && row === 12 ? 'Detailed subsection' : `Page ${n} line ${row+1}: Ordinary readable prose has enough words to reflow.`, 120+row*22, n === 2 && row === 12 ? 18 : 12));
    const stream = commands.join('\n');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id+1} 0 R >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  const root = objects.length + 1;
  objects[0] = `<< /Type /Catalog /Pages 2 0 R ${outline ? `/Outlines ${root} 0 R /Names << /Dests << /Names [(detail) [${kids[1]} 0 R /XYZ 0 425 null]] >> >>` : ''} >>`;
  objects[1] = `<< /Type /Pages /Count 4 /Kids [${kids.map(n=>`${n} 0 R`).join(' ')}] >>`;
  if (outline) objects.push(`<< /Type /Outlines /First ${root+1} 0 R /Last ${root+3} 0 R /Count 3 >>`,
    `<< /Title (Chapter One) /Parent ${root} 0 R /Dest [${kids[0]} 0 R /Fit] /First ${root+2} 0 R /Last ${root+2} 0 R /Next ${root+3} 0 R /Count 1 >>`,
    `<< /Title (Detailed subsection) /Parent ${root+1} 0 R /Dest (detail) >>`,
    `<< /Title (Chapter Two) /Parent ${root} 0 R /Dest [${kids[3]} 0 R /Fit] /Prev ${root+1} 0 R >>`);
  let source = '%PDF-1.7\n'; const offsets = [0];
  objects.forEach((object,i)=>{offsets.push(Buffer.byteLength(source));source+=`${i+1} 0 obj\n${object}\nendobj\n`;});
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length+1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('');
  source += `trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source);
}
