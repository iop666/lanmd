import { memo, useRef, useState } from 'react';
import type { TreeNode } from '../api';

interface Props {
  items: TreeNode[];
  activePath: string | null;
  onOpenFile: (path: string) => void;
  onContext: (node: TreeNode, x: number, y: number) => void;
}

/** 移动端长按 500ms 触发上下文菜单；桌面端 contextmenu 右键 */
function usePress(node: TreeNode, onLong: (x: number, y: number) => void, onClick: () => void) {
  const timer = useRef<number | undefined>(undefined);
  const fired = useRef(false);
  return {
    onClick: () => {
      if (fired.current) {
        fired.current = false;
        return;
      }
      onClick();
    },
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      onLong(e.clientX, e.clientY);
    },
    onTouchStart: (e: React.TouchEvent) => {
      fired.current = false;
      const t = e.touches[0];
      timer.current = window.setTimeout(() => {
        fired.current = true;
        onLong(t.clientX, t.clientY);
      }, 500);
    },
    onTouchEnd: () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current);
    },
    onTouchMove: () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current);
    },
  };
}

interface RowProps {
  node: TreeNode;
  depth: number;
  activePath: string | null;
  onOpenFile: (path: string) => void;
  onContext: (node: TreeNode, x: number, y: number) => void;
  collapsed: Set<string>;
  toggle: (p: string) => void;
}

function Row({ node, depth, activePath, onOpenFile, onContext, collapsed, toggle }: RowProps) {
  const isDir = node.type === 'dir';
  const press = usePress(
    node,
    (x, y) => onContext(node, x, y),
    () => {
      if (isDir) toggle(node.path);
      else onOpenFile(node.path);
    },
  );
  const isActive = !isDir && node.path === activePath;
  const isCollapsed = collapsed.has(node.path);
  const kids = isDir && !isCollapsed ? (node.children ?? []) : [];
  return (
    <>
      <div
        className={`tree-row${isActive ? ' active' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        {...press}
      >
        <span className="tree-icon">{isDir ? (isCollapsed ? '▸' : '▾') : '📄'}</span>
        <span className="tree-name">{node.name}</span>
      </div>
      {kids.map((c) => (
        <Row
          key={c.path}
          node={c}
          depth={depth + 1}
          activePath={activePath}
          onOpenFile={onOpenFile}
          onContext={onContext}
          collapsed={collapsed}
          toggle={toggle}
        />
      ))}
    </>
  );
}

function FileTreeInner(props: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (p: string): void => {
    setCollapsed((prev) => {
      const n = new Set(prev);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });
  };
  return (
    <div className="tree-list">
      {props.items.map((n) => (
        <Row
          key={n.path}
          node={n}
          depth={0}
          collapsed={collapsed}
          toggle={toggle}
          activePath={props.activePath}
          onOpenFile={props.onOpenFile}
          onContext={props.onContext}
        />
      ))}
    </div>
  );
}

export default memo(FileTreeInner);
