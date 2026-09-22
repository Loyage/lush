// 文档量只有几十篇：首次搜索时拉一份轻量索引，在浏览器做确定性的中英文子串匹配。
// 不做分词/词干化；中文天然按连续字符命中，英文空格分成 AND 条件。

export function normalizeDocsQuery(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

const countOf = (text, term, limit = 6) => {
  let count = 0, at = 0;
  while (count < limit && (at = text.indexOf(term, at)) >= 0) { count++; at += Math.max(1, term.length); }
  return count;
};

function snippet(row, terms) {
  const candidates = [row.body, row.code, row.headings, row.diagram].map(value => String(value || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  for (const source of candidates) {
    const normalized = normalizeDocsQuery(source);
    let at = -1;
    for (const term of terms) {
      const hit = normalized.indexOf(term);
      if (hit >= 0 && (at < 0 || hit < at)) at = hit;
    }
    if (at < 0) continue;
    const from = Math.max(0, at - 48), to = Math.min(source.length, at + 112);
    return `${from ? '…' : ''}${source.slice(from, to).trim()}${to < source.length ? '…' : ''}`;
  }
  return '';
}

/** 返回按相关度排序的 `{ id,title,group,path,score,snippet }`。 */
export function searchDocs(index, query, limit = 30) {
  const phrase = normalizeDocsQuery(query);
  if (!phrase) return [];
  const terms = [...new Set(phrase.split(' ').filter(Boolean))];
  const results = [];
  for (const row of index || []) {
    const fields = {
      title: normalizeDocsQuery(row.title), path: normalizeDocsQuery(row.path),
      headings: normalizeDocsQuery(row.headings), body: normalizeDocsQuery(row.body),
      code: normalizeDocsQuery(row.code), diagram: normalizeDocsQuery(row.diagram),
    };
    const all = Object.values(fields).join('\n');
    if (!terms.every(term => all.includes(term))) continue;
    let score = 0;
    for (const term of terms) {
      score += countOf(fields.title, term, 2) * 140;
      score += countOf(fields.headings, term, 4) * 80;
      score += countOf(fields.path, term, 2) * 55;
      score += countOf(fields.code, term, 6) * 45;
      score += countOf(fields.body, term, 6) * 22;
      score += countOf(fields.diagram, term, 3) * 4;
    }
    if (fields.title.includes(phrase)) score += 220;
    else if (fields.headings.includes(phrase)) score += 100;
    else if (fields.code.includes(phrase)) score += 60;
    else if (fields.body.includes(phrase)) score += 30;
    results.push({ id: row.id, title: row.title, group: row.group, path: row.path, score, snippet: snippet(row, terms) });
  }
  return results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
}
