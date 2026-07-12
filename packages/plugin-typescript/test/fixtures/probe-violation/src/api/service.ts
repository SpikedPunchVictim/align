// Seeded violation: backend code must never import frontend modules.
import { render } from '../ui/component.js';

export function handleRequest(): string {
  return render();
}
