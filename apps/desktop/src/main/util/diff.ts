/**
 * 行级 unified diff（审批卡片里展示 sftp_write 的改动）。基于最长公共子序列；超过 maxLines 的文件只给出概要。
 */
export function unifiedDiff(before: string, after: string, opts: { context?: number; maxLines?: number; label?: string } = {}): string {
  const context = opts.context ?? 3;
  const maxLines = opts.maxLines ?? 4000;
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  const header = `--- ${opts.label ?? 'a'}\n+++ ${opts.label ?? 'b'}`;
  if (a.length > maxLines || b.length > maxLines) {
    return `${header}\n@@ 文件太大（${a.length} → ${b.length} 行），不展示逐行对比 @@`;
  }
  // 去掉相同的头尾，减少 LCS 的规模
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ma = a.slice(start, endA);
  const mb = b.slice(start, endB);
  const n = ma.length;
  const m = mb.length;
  // LCS 表（逆序填写）
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = ma[i] === mb[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  type Op = { t: ' ' | '-' | '+'; s: string; ai: number; bi: number };
  const ops: Op[] = [];
  for (let k = 0; k < start; k++) ops.push({ t: ' ', s: a[k], ai: k, bi: k });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && ma[i] === mb[j]) {
      ops.push({ t: ' ', s: ma[i], ai: start + i, bi: start + j });
      i++;
      j++;
    } else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) {
      // 同样长时先输出删除行（和 git diff 一致：-旧 +新）
      ops.push({ t: '-', s: ma[i], ai: start + i, bi: start + j });
      i++;
    } else {
      ops.push({ t: '+', s: mb[j], ai: start + i, bi: start + j });
      j++;
    }
  }
  for (let k = 0; k < a.length - endA; k++) ops.push({ t: ' ', s: a[endA + k], ai: endA + k, bi: endB + k });
  if (!ops.some((o) => o.t !== ' ')) return `${header}\n@@ 内容没有变化 @@`;

  // 分组成 hunk
  const out: string[] = [header];
  let idx = 0;
  while (idx < ops.length) {
    while (idx < ops.length && ops[idx].t === ' ') idx++;
    if (idx >= ops.length) break;
    const from = Math.max(0, idx - context);
    let to = idx;
    let lastChange = idx;
    while (to < ops.length && (ops[to].t !== ' ' || to - lastChange <= context * 2)) {
      if (ops[to].t !== ' ') lastChange = to;
      to++;
    }
    to = Math.min(ops.length, lastChange + context + 1);
    const hunk = ops.slice(from, to);
    const aStart = hunk[0].ai + 1;
    const bStart = hunk[0].bi + 1;
    const aCount = hunk.filter((o) => o.t !== '+').length;
    const bCount = hunk.filter((o) => o.t !== '-').length;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const o of hunk) out.push(`${o.t}${o.s}`);
    idx = to;
  }
  return out.join('\n');
}
