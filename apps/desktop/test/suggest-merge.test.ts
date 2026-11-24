import { describe, expect, it } from 'vitest';
import { matchLibrary, mergeSuggestions, SUGGEST_TOTAL } from '../src/renderer/src/util/command-library';

describe('命令提示合并：系统推荐在前、历史在后', () => {
  it('输入 docker：docker ps 带说明排在前面，历史命令跟在后面，最多 20 条', () => {
    const history = ['docker ps -a --format "{{.Names}}"', 'docker compose up -d', 'docker logs -f web', 'docker exec -it web bash'];
    const out = mergeSuggestions('docker', { library: matchLibrary('docker', SUGGEST_TOTAL), snippets: [], history });
    expect(out.length).toBe(SUGGEST_TOTAL);
    expect(out[0]).toMatchObject({ command: 'docker ps', source: 'library' });
    expect(out[0].description).toBeTruthy();
    const firstHistory = out.findIndex((s) => s.source === 'history');
    expect(firstHistory).toBeGreaterThan(0);
    expect(out.slice(firstHistory).every((s) => s.source === 'history')).toBe(true);
    expect(out.filter((s) => s.source === 'history').map((s) => s.command)).toEqual(history);
  });

  it('历史和系统推荐一模一样时只保留系统推荐（忽略多余空格）', () => {
    const out = mergeSuggestions('git s', { library: matchLibrary('git s', SUGGEST_TOTAL), snippets: [], history: ['git status', 'git  stash ', 'git show HEAD'] });
    expect(out.map((s) => [s.command, s.source])).toEqual([
      ['git status', 'library'],
      ['git stash', 'library'],
      ['git stash pop', 'library'],
      ['git show HEAD', 'history'],
    ]);
  });

  it('历史很多时系统推荐最多占 12 条；和被截掉的系统推荐相同的历史仍按系统推荐显示', () => {
    const lib = matchLibrary('docker', SUGGEST_TOTAL);
    const cut = lib[15].command;
    const history = [cut, ...Array.from({ length: 30 }, (_, i) => `docker run img-${i}`)];
    const out = mergeSuggestions('docker', { library: lib, snippets: [], history });
    expect(out.length).toBe(SUGGEST_TOTAL);
    expect(out.slice(0, 12).every((s) => s.source === 'library')).toBe(true);
    expect(out[12]).toMatchObject({ command: cut, source: 'library', description: lib[15].description });
    expect(out.slice(13).every((s) => s.source === 'history')).toBe(true);
  });

  it('快捷命令也算系统推荐，排在历史前面；和输入完全相同的不出现', () => {
    const out = mergeSuggestions('echo hi', { library: [], snippets: ['echo hi there'], history: ['echo hi', 'echo hi there', 'echo history-one'] });
    expect(out.map((s) => [s.command, s.source])).toEqual([
      ['echo hi there', 'snippet'],
      ['echo history-one', 'history'],
    ]);
  });
});
