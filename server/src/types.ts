export type BusEvent =
  | { kind: 'file-changed'; path: string; version: string; mtime: number }
  | { kind: 'file-removed'; path: string }
  | { kind: 'tree-changed' };
