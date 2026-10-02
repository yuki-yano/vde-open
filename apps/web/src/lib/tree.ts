import type { DocumentSummary } from '@vde-open/shared';

// sidebarのtree（仕様13.1）。登録済みの文書のpathから作る表示で、filesystemは操作しない。
export type TreeNode =
  | { kind: 'directory'; name: string; children: TreeNode[] }
  | { kind: 'document'; name: string; document: DocumentSummary };

export const INPUT_GROUP_NAME = '入力・生成文書';

interface Branch {
  directories: Map<string, Branch>;
  documents: DocumentSummary[];
}

function emptyBranch(): Branch {
  return { directories: new Map(), documents: [] };
}

function commonPrefixLength(paths: string[][]): number {
  if (paths.length === 0) return 0;
  // fileの名前は残し、directoryの部分だけを比べる。
  const directories = paths.map((segments) => segments.slice(0, -1));
  const shortest = Math.min(...directories.map((segments) => segments.length));
  let length = 0;
  while (
    length < shortest &&
    directories.every((segments) => segments[length] === directories[0]?.[length])
  ) {
    length += 1;
  }
  return length;
}

function toNodes(branch: Branch): TreeNode[] {
  const nodes: TreeNode[] = [];
  for (const [name, child] of branch.directories) {
    // 子が1つのdirectoryだけなら、`a/b/c`のように1行へまとめる。
    let label = name;
    let current = child;
    while (current.documents.length === 0 && current.directories.size === 1) {
      const [nextName, next] = [...current.directories.entries()][0] as [string, Branch];
      label = `${label}/${nextName}`;
      current = next;
    }
    nodes.push({ kind: 'directory', name: label, children: toNodes(current) });
  }
  for (const document of branch.documents) {
    nodes.push({
      kind: 'document',
      name: document.pathSegments.at(-1) ?? document.title,
      document,
    });
  }
  return nodes;
}

export function buildTree(documents: DocumentSummary[]): TreeNode[] {
  const files = documents.filter((document) => document.sourceKind === 'file');
  const others = documents.filter((document) => document.sourceKind !== 'file');
  // すべての文書に共通する親directoryは省く。rootが違う文書は、違いが残るところから表示される。
  const skip = commonPrefixLength(files.map((document) => document.pathSegments));
  const root = emptyBranch();
  for (const document of files) {
    let branch = root;
    for (const segment of document.pathSegments.slice(skip, -1)) {
      let next = branch.directories.get(segment);
      if (!next) {
        next = emptyBranch();
        branch.directories.set(segment, next);
      }
      branch = next;
    }
    branch.documents.push(document);
  }
  const nodes = toNodes(root);
  if (others.length > 0) {
    nodes.push({
      kind: 'directory',
      name: INPUT_GROUP_NAME,
      children: others.map((document) => ({ kind: 'document', name: document.title, document })),
    });
  }
  return nodes;
}
