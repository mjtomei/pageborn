// Deterministic cases shared by layout, phone-browser and simulator checks.
function scenario(id, headers, cells, probes) {
  const markdown = `# ${id}\n\n| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n`
    + cells.map(row => `| ${row.join(' | ')} |`).join('\n')
    + '\n\n## After the table\n\n' + 'Following paragraph, outside the table.\n\n'.repeat(12);
  return { id, headers, cells, probes, markdown };
}

export function tableStressCases() {
  const tall = Array.from({ length: 2000 }, (_, r) => Array.from({ length: 8 }, (_, c) =>
    `R${String(r + 1).padStart(4, '0')}C${c + 1} value for this record`));
  const wide = Array.from({ length: 6 }, (_, r) => Array.from({ length: 40 }, (_, c) =>
    `WideR${r + 1}C${String(c + 1).padStart(2, '0')} ` + 'A longer field with several wrapped lines. '.repeat((r + c) % 5)));
  const prose = 'CellStart ' + 'A large cell keeps every word as it crosses the screen. '.repeat(1300)
    + 'CellMiddle ' + 'More content in the same cell after its midpoint. '.repeat(1300) + 'CellEnd';
  const token = 'LongTokenStart' + 'abcdefghij'.repeat(6400) + 'LongTokenEnd';
  const unicode = 'UnicodeStart ' + '中文 café 👓 e\u0301 '.repeat(1800) + 'UnicodeEnd';
  return [
    scenario('tall-table', Array.from({ length: 8 }, (_, c) => `Field ${c + 1}`), tall, ['R0001C1', 'R1000C8', 'R2000C8']),
    scenario('wide-table', Array.from({ length: 40 }, (_, c) => c === 19 ? 'Very long column heading '.repeat(20).trim() : `Column ${c + 1}`), wide, ['WideR1C01', 'WideR3C20', 'WideR6C40']),
    scenario('huge-cells', ['Name', 'Details', 'After'], [['Prose', prose, 'AfterProse'], ['Unbroken token', token, 'AfterToken'], ['Unicode', unicode, 'AfterUnicode']],
      ['CellStart', 'CellMiddle', 'CellEnd', 'LongTokenEnd', 'UnicodeEnd', 'AfterUnicode']),
  ];
}
