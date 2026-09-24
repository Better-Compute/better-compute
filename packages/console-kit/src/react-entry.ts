import * as React from 'react';
import { bindReact } from './react.js';

// `@better-compute/console-kit/react`: the hooks bound to the app's `react` (an optional peer).
// Apps that bring their own React build (or preact/compat) can call `bindReact` from the main entry.

export const hooks = bindReact(React);
export const { useStore, useList, usePermission, useDetail, useAction } = hooks;
export { bindReact, type ConsoleHooks, type ReactLike } from './react.js';
