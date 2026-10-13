/**
 * A toast with buttons, for a viewer action the user must confirm (relaxing
 * a filter, raising the render cap). It stays longer than a plain toast
 * (showToast in guide/guide-panel.ts) so there is time to click.
 */

export interface ToastAction {
  label: string;
  run: () => void;
}

const ACTION_TOAST_MS = 8000;

/** Show the toast; returns it so the caller can remove it early. */
export function showActionToast(message: string, actions: ToastAction[]): HTMLElement | null {
  const container = document.getElementById('toast-container');
  if (!container) return null;

  const toast = document.createElement('div');
  toast.className = 'toast toast-with-actions';
  toast.textContent = message;
  for (const action of actions) {
    const button = document.createElement('button');
    button.className = 'toast-action';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      toast.remove();
      action.run();
    });
    toast.appendChild(button);
  }
  container.appendChild(toast);

  setTimeout(() => toast.remove(), ACTION_TOAST_MS);
  return toast;
}
