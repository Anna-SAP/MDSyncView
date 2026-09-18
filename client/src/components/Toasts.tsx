import { useStore } from '../store.ts';

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  if (!toasts.length) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => dismiss(t.id)}>
          <span>{t.text}</span>
          {t.action && <button className="btn small" onClick={(e) => { e.stopPropagation(); t.action!.run(); dismiss(t.id); }}>{t.action.label}</button>}
        </div>
      ))}
    </div>
  );
}
