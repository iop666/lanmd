export type BusEvent =
  | { kind: 'file-changed'; path: string; version: string; mtime: number }
  | { kind: 'file-removed'; path: string }
  | { kind: 'tree-changed' }
  /** 任务单有增删或状态变化，各端重新拉一次列表 */
  | { kind: 'tasks-changed' };
