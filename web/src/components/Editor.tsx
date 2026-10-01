import { useEffect, useRef } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { indentWithTab } from '@codemirror/commands';
import { oneDark } from '@codemirror/theme-one-dark';

interface Props {
  path: string | null;
  /** 远端/打开时的「真相内容」。只在打开文件、外部同步、放弃改动时变化。 */
  value: string;
  onChange: (content: string) => void;
  onSave: () => void;
}

/** 前后缀公共部分定位最小差异，配合 CM dispatch 保持光标位置 */
function diffChange(oldStr: string, newStr: string): { from: number; to: number; insert: string } | null {
  if (oldStr === newStr) return null;
  let start = 0;
  const min = Math.min(oldStr.length, newStr.length);
  while (start < min && oldStr.charCodeAt(start) === newStr.charCodeAt(start)) start++;
  let endOld = oldStr.length;
  let endNew = newStr.length;
  while (endOld > start && endNew > start && oldStr.charCodeAt(endOld - 1) === newStr.charCodeAt(endNew - 1)) {
    endOld--;
    endNew--;
  }
  return { from: start, to: endOld, insert: newStr.slice(start, endNew) };
}

export default function Editor({ path, value, onChange, onSave }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lastApplied = useRef<string>('');
  const appliedPath = useRef<string | null>(null);
  const suppressChange = useRef(false);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const valueRef = useRef(value);
  const pathRef = useRef(path);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  valueRef.current = value;
  pathRef.current = path;
  const themeComp = useRef(new Compartment());

  useEffect(() => {
    if (!hostRef.current) return;
    const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const view = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [
          basicSetup,
          markdown(),
          EditorView.lineWrapping,
          themeComp.current.of(darkQuery.matches ? oneDark : []),
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => { onSaveRef.current(); return true; } },
            indentWithTab,
          ]),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            if (suppressChange.current) {
              suppressChange.current = false;
              return;
            }
            onChangeRef.current(u.state.doc.toString());
          }),
          EditorView.contentAttributes.of({
            autocorrect: 'off',
            autocapitalize: 'off',
            spellcheck: 'false',
          }),
        ],
      }),
      parent: hostRef.current,
    });
    viewRef.current = view;

    // 若挂载时已带内容（React StrictMode 下 effect 重跑等场景），补一次全量灌入
    if (pathRef.current !== null && valueRef.current !== '') {
      suppressChange.current = true;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: valueRef.current },
      });
      lastApplied.current = valueRef.current;
      appliedPath.current = pathRef.current;
    }

    const onThemeChange = (): void => {
      view.dispatch({ effects: themeComp.current.reconfigure(darkQuery.matches ? oneDark : []) });
    };
    darkQuery.addEventListener('change', onThemeChange);

    // 移动端软键盘弹出/聚焦时把光标位置滚到视口中部
    const onFocus = (): void => {
      requestAnimationFrame(() => {
        try {
          view.dispatch({
            effects: EditorView.scrollIntoView(view.state.selection.main, { y: 'center' }),
          });
        } catch {
          /* ignore */
        }
      });
    };
    view.contentDOM.addEventListener('focus', onFocus);

    return () => {
      darkQuery.removeEventListener('change', onThemeChange);
      view.contentDOM.removeEventListener('focus', onFocus);
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // 外部内容同步：切换文件全量替换，同文件做最小 diff，避免光标跳动
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (path !== appliedPath.current) {
      appliedPath.current = path;
      lastApplied.current = value;
      if (view.state.doc.toString() !== value) {
        suppressChange.current = true;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
      }
      return;
    }
    if (value === lastApplied.current) return;
    const cur = view.state.doc.toString();
    if (value === cur) {
      lastApplied.current = value;
      return;
    }
    const ch = diffChange(cur, value);
    if (ch) {
      suppressChange.current = true;
      view.dispatch({ changes: ch });
    }
    lastApplied.current = value;
  }, [value, path]);

  return <div className="editor-host" ref={hostRef} />;
}
