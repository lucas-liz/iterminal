import JSZip from 'jszip';

/** 测试用的最小 .docx：一个一级标题、一段带粗体的正文、一个两行两列的表格、一个列表项（第二十六轮，笔记导入 Word） */
export async function makeDocx(): Promise<Buffer> {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const p = (text: string, style?: string, bold = false): string =>
    `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const cell = (t: string): string => `<w:tc>${p(t)}</w:tc>`;
  const body =
    p('发布手册', 'Heading1') +
    `<w:p><w:r><w:t xml:space="preserve">先执行 </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>备份</w:t></w:r></w:p>` +
    `<w:tbl><w:tr>${cell('主机')}${cell('端口')}</w:tr><w:tr>${cell('web-01')}${cell('22')}</w:tr></w:tbl>` +
    p('检查磁盘');
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
  );
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  zip.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}
