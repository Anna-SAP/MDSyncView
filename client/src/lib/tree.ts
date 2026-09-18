import type { FileRecord, RootInfo } from '../../../shared/types.ts';
import { collator, splitPath } from './format.ts';

export interface DirNode {
  /** canonical key (lowercase, forward slashes) */
  key: string;
  name: string;
  path: string;
  depth: number;
  children: DirNode[];
  files: FileRecord[];
  /** total files in this subtree */
  count: number;
  /** latest mtime in subtree */
  latest: number;
  isRoot: boolean;
}

export type TreeRow =
  | { kind: 'dir'; node: DirNode; depth: number; expanded: boolean; label: string; key: string }
  | { kind: 'file'; file: FileRecord; depth: number; key: string };

function keyOf(displayPath: string): string {
  let k = displayPath.replace(/\\/g, '/').toLowerCase();
  if (k.length > 1 && k.endsWith('/')) k = k.slice(0, -1);
  return k;
}

/** Build a directory tree from the flat file list, one top-level node per root. */
export function buildTree(files: Iterable<FileRecord>, roots: RootInfo[]): DirNode[] {
  const rootNodes = new Map<string, DirNode>();
  const rootList = [...roots].sort((a, b) => b.key.length - a.key.length); // longest first for matching
  for (const r of roots) {
    rootNodes.set(r.key, { key: r.key, name: r.path, path: r.path, depth: 0, children: [], files: [], count: 0, latest: 0, isRoot: true });
  }
  const orphan: DirNode = { key: '~', name: '其他位置', path: '', depth: 0, children: [], files: [], count: 0, latest: 0, isRoot: true };
  const dirIndex = new Map<string, DirNode>();
  for (const n of rootNodes.values()) dirIndex.set(n.key, n);

  for (const f of files) {
    const dirKey = keyOf(f.dir);
    let rootNode = rootNodes.get(f.root);
    if (!rootNode) {
      const match = rootList.find((r) => dirKey === r.key || dirKey.startsWith(r.key + '/'));
      rootNode = match ? rootNodes.get(match.key) : undefined;
    }
    if (!rootNode) rootNode = orphan;
    const node = ensureDir(rootNode, dirKey, f.dir, dirIndex);
    node.files.push(f);
    for (let n: DirNode | undefined = node; n; n = parentOf(n, dirIndex, rootNode)) {
      n.count++;
      if (f.mtime > n.latest) n.latest = f.mtime;
      if (n === rootNode) break;
    }
  }
  const out = [...rootNodes.values()];
  if (orphan.count) out.push(orphan);
  for (const n of out) sortNode(n);
  return out;
}

function parentOf(n: DirNode, dirIndex: Map<string, DirNode>, root: DirNode): DirNode | undefined {
  if (n === root) return undefined;
  const i = n.key.lastIndexOf('/');
  if (i < 0) return root;
  const pk = n.key.slice(0, i);
  return dirIndex.get(pk) ?? root;
}

function ensureDir(root: DirNode, dirKey: string, displayDir: string, dirIndex: Map<string, DirNode>): DirNode {
  if (dirKey === root.key) return root;
  const existing = dirIndex.get(dirKey);
  if (existing) return existing;
  // build chain from root
  const relKey = root.key === '~' ? dirKey : dirKey.slice(root.key.length).replace(/^\//, '');
  const segsKey = relKey.split('/').filter(Boolean);
  const segsDisplay = root.key === '~' ? splitPath(displayDir) : splitPath(displayDir).slice(splitPath(root.path).length);
  let cur = root;
  let curKey = root.key === '~' ? '' : root.key;
  let curPath = root.key === '~' ? '' : root.path;
  const sep = displayDir.includes('\\') ? '\\' : '/';
  for (let i = 0; i < segsKey.length; i++) {
    curKey = curKey ? curKey + '/' + segsKey[i] : segsKey[i]!;
    const disp = segsDisplay[i] ?? segsKey[i]!;
    curPath = curPath ? (curPath.endsWith(sep) ? curPath + disp : curPath + sep + disp) : disp + (sep === '\\' && /^[a-z]:$/i.test(disp) ? '\\' : '');
    let next = dirIndex.get(curKey);
    if (!next) {
      next = { key: curKey, name: disp, path: curPath, depth: cur.depth + 1, children: [], files: [], count: 0, latest: 0, isRoot: false };
      dirIndex.set(curKey, next);
      cur.children.push(next);
    }
    cur = next;
  }
  return cur;
}

function sortNode(n: DirNode): void {
  n.children.sort((a, b) => collator.compare(a.name, b.name));
  n.files.sort((a, b) => collator.compare(a.name, b.name));
  for (const c of n.children) sortNode(c);
}

/** Flatten the tree for virtualization, compacting single-child directory chains ("a / b / c"). */
export function flattenTree(nodes: DirNode[], expanded: Set<string>, filter?: (f: FileRecord) => boolean): TreeRow[] {
  const rows: TreeRow[] = [];
  const visit = (node: DirNode, depth: number, labelPrefix: string) => {
    // compact chains: dir with exactly one child dir and no files
    let n = node;
    let label = labelPrefix + n.name;
    while (!n.isRoot && n.children.length === 1 && n.files.length === 0) {
      n = n.children[0]!;
      label += ' / ' + n.name;
    }
    if (filter && !subtreeHas(n, filter)) return;
    const isOpen = expanded.has(n.key) || (filter !== undefined);
    rows.push({ kind: 'dir', node: n, depth, expanded: isOpen, label, key: 'd:' + n.key });
    if (!isOpen) return;
    for (const c of n.children) visit(c, depth + 1, '');
    for (const f of n.files) if (!filter || filter(f)) rows.push({ kind: 'file', file: f, depth: depth + 1, key: 'f:' + f.key });
  };
  for (const r of nodes) visit(r, 0, '');
  return rows;
}

function subtreeHas(n: DirNode, filter: (f: FileRecord) => boolean): boolean {
  if (n.files.some(filter)) return true;
  return n.children.some((c) => subtreeHas(c, filter));
}

/** Keys of every ancestor directory of a file (for auto-expanding the tree to reveal it). */
export function ancestorKeys(file: FileRecord): string[] {
  const dirKey = keyOf(file.dir);
  const out: string[] = [];
  let k = dirKey;
  while (k) {
    out.push(k);
    const i = k.lastIndexOf('/');
    if (i < 0) break;
    k = k.slice(0, i);
  }
  return out;
}
