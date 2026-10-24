export function pdfAnalysisViewport(page, turn = 0) {
  const rotation = (page.rotate + turn) % 360;
  const base = page.getViewport({ scale: 1, rotation });
  return page.getViewport({ rotation, scale: Math.min(900 / base.width, 4096 / base.height, Math.sqrt(2_000_000 / (base.width * base.height))) });
}

export function pdfQuarterTurnNeeded(lines) {
  const letters = line => (line.text.match(/[A-Za-z]/g) || []).length;
  const total = lines.reduce((sum, line) => sum + letters(line), 0);
  const sideways = lines.filter(line => line.height > line.width * 2 && line.height > 60);
  return sideways.length >= 3 && total > 60 && sideways.reduce((sum, line) => sum + letters(line), 0) > total * .4;
}

export function pdfOcrScore(lines) {
  let weight = 0; let sum = 0;
  for (const line of lines) {
    const n = (line.text.match(/[A-Za-z]{2,}/g) || []).join('').length;
    if (line.width < line.height * 2) continue;
    weight += n; sum += n * Math.max(0, line.confidence - 35);
  }
  return { quality: weight ? sum / weight : 0, score: sum, letters: weight };
}

// Mapping from corrected analysis coordinates to the original orientation.
// Existing bookmarks continue to refer to the same physical source page.
export function pdfSourceTransform(original, corrected) {
  const [a,b,c,d,e,f] = corrected.transform;
  const det = a*d-b*c;
  const inverse = [d/det,-b/det,-c/det,a/det,(c*f-d*e)/det,(b*e-a*f)/det];
  const [g,h,i,j,k,l] = original.transform;
  return [g*inverse[0]+i*inverse[1],h*inverse[0]+j*inverse[1],
    g*inverse[2]+i*inverse[3],h*inverse[2]+j*inverse[3],
    g*inverse[4]+i*inverse[5]+k,h*inverse[4]+j*inverse[5]+l];
}

export function pdfSourcePoint(block, point, inverse = false) {
  const m = block.sourceTransform;
  if (!m) return point;
  const [a,b,c,d,e,f] = m;
  if (!inverse) return { x: a*point.x+c*point.y+e, y: b*point.x+d*point.y+f };
  const det = a*d-b*c; const x = point.x-e; const y = point.y-f;
  return { x: (d*x-c*y)/det, y: (a*y-b*x)/det };
}

// Confirm separate serif-I glyphs in a tiny heading. OCR frequently returns
// 11/111 here; require both serifs and a narrow stem before correcting digits.
export function pdfRomanStrokes(data, width, height) {
  const groups=[]; let group;
  for(let x=0;x<width;x++) {
    const rows=[];
    for(let y=0;y<height;y++) if(data[(y*width+x)*4]<160) rows.push(y);
    if(rows.length) { if(!group){group=[];groups.push(group);}group.push({x,rows}); } else group=null;
  }
  const glyphs=groups.filter(g=>g.reduce((n,col)=>n+col.rows.length,0)>=12);
  if(glyphs.length<2||glyphs.length>4) return null;
  const sizes=[];
  for(const g of glyphs) {
    const top=Math.min(...g.flatMap(col=>col.rows)),low=Math.max(...g.flatMap(col=>col.rows));
    const h=low-top+1; const w=g.at(-1).x-g[0].x+1;
    if(h<10||w>h*.9||w<h*.15)return null;
    const at = fraction => g.filter(col=>col.rows.some(y=>Math.abs(y-(top+h*fraction))<h*.1)).length;
    const upper=at(.12),stem=at(.5),lower=at(.88);
    if(upper<w*.65||lower<w*.65||stem>Math.min(upper,lower)*.8)return null;
    sizes.push(h);
  }
  return Math.min(...sizes)>=Math.max(...sizes)*.8 ? 'I'.repeat(glyphs.length) : null;
}
