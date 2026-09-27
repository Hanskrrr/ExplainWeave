import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';

export interface MarkdownEditorProps {
  initialValue: string;
  label: string;
  onChange: (value: string) => void;
  onSelectionChange?: (selection: { from: number; to: number }) => void;
  onSave?: () => void;
}

/** An editor lives for the editing session, including during IME composition. */
export function MarkdownEditor(props: MarkdownEditorProps) {
  const mount = useRef<HTMLDivElement>(null);
  const callbacks = useRef(props);
  callbacks.current = props;

  useEffect(() => {
    if (!mount.current) return;
    const view = new EditorView({
      parent: mount.current,
      state: EditorState.create({
        doc: callbacks.current.initialValue,
        extensions: [
          markdown(),
          history(),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            'aria-label': callbacks.current.label,
            'aria-multiline': 'true',
            role: 'textbox',
            spellcheck: 'false',
          }),
          keymap.of([{ key: 'Mod-Enter', run: () => {
            if (!view.composing) callbacks.current.onSave?.();
            return true;
          } }, ...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of(update => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
            if (update.selectionSet || update.docChanged) {
              const { from, to } = update.state.selection.main;
              callbacks.current.onSelectionChange?.({ from, to });
            }
          }),
          EditorView.theme({
            '&': { fontSize: 'var(--font-text-size, 15px)' },
            '&.cm-focused': { outline: 'none' },
            '.cm-content': { fontFamily: 'var(--font-monospace)', minHeight: '140px', padding: '12px' },
            '.cm-line': { padding: '0', lineHeight: '1.7' },
            '.cm-scroller': { overflow: 'auto' },
          }),
        ],
      }),
    });
    view.focus();
    return () => view.destroy();
  }, []);

  return <div className="ew-markdown-editor" ref={mount} />;
}
