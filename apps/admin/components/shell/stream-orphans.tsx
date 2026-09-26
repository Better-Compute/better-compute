'use client';

import { useEffect } from 'react';

/**
 * React streams a suspended page as `<template id="B:n">` in place plus a later `<div hidden id="S:n">` that its
 * `$RC` script swaps in. When a context update reaches the boundary before that content arrives (the shell's
 * providers settle right after hydration: saved preferences, the connection probe), React client-renders the
 * boundary and drops the template, so `$RC` finds no target and the hidden server copy stays under <body>: a
 * second, invisible copy of the page (duplicate ids and buttons, double DOM weight). This removes exactly those
 * orphans: a hidden `S:n` segment whose `B:n` placeholder no longer exists.
 */
export function StreamOrphanSweeper() {
  useEffect(() => {
    const sweep = () => {
      for (const segment of document.querySelectorAll<HTMLElement>('body > div[hidden][id^="S:"]')) {
        if (!document.getElementById(`B:${segment.id.slice(2)}`)) segment.remove();
      }
    };
    sweep();
    const observer = new MutationObserver(sweep);
    observer.observe(document.body, { childList: true });
    return () => observer.disconnect();
  }, []);
  return null;
}
