// This bare import resolves THROUGH the node_modules/@fixture/pkg-b symlink — a naive
// `path.includes('node_modules')` classification (pre-ADR-004 fix) would misclassify this as an
// external edge and silently drop it from the graph.
import { value } from '@fixture/pkg-b';

export const doubled = value * 2;
